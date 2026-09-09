import { Injectable } from '@nestjs/common';
import { MediaPurpose, MediaStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  MediaRepository,
  type CompletePendingMediaInput,
  type CreatePendingMediaInput,
} from './media.repository';
import type {
  CompletePendingMediaResult,
  CreatePendingMediaResult,
  MediaAssetRecord,
  MediaProfileUserRecord,
  SetProfileAvatarResult,
} from './media.types';

const mediaAssetSelect = {
  id: true,
  ownerId: true,
  clientUploadId: true,
  purpose: true,
  status: true,
  uploadFingerprint: true,
  contentSha256: true,
  cloudinaryPublicId: true,
  cloudinaryAssetId: true,
  resourceType: true,
  deliveryType: true,
  format: true,
  mimeType: true,
  byteSize: true,
  width: true,
  height: true,
  durationMs: true,
  originalFilename: true,
  secureUrl: true,
  etag: true,
  expiresAt: true,
  completedAt: true,
  failedAt: true,
  deletedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MediaAssetSelect;

type SelectedMediaAsset = Prisma.MediaAssetGetPayload<{
  select: typeof mediaAssetSelect;
}>;

const mediaProfileUserSelect = {
  id: true,
  phoneNumber: true,
  displayName: true,
  avatarUrl: true,
  profileCompletedAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

const supportedMediaPurposes = [
  MediaPurpose.PROFILE_AVATAR,
  MediaPurpose.MESSAGE_ATTACHMENT,
] as const;

@Injectable()
export class PrismaMediaRepository extends MediaRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async createPending(
    input: CreatePendingMediaInput,
  ): Promise<CreatePendingMediaResult> {
    try {
      const asset = await this.prisma.mediaAsset.create({
        data: {
          id: input.id.toLowerCase(),
          ownerId: input.ownerId.toLowerCase(),
          clientUploadId: input.clientUploadId.toLowerCase(),
          purpose: input.purpose,
          status: MediaStatus.PENDING,
          uploadFingerprint: input.uploadFingerprint,
          contentSha256: input.contentSha256,
          cloudinaryPublicId: input.cloudinaryPublicId,
          resourceType: input.resourceType,
          deliveryType: input.deliveryType,
          mimeType: input.mimeType,
          byteSize: input.byteSize,
          originalFilename: input.originalFilename,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        },
        select: mediaAssetSelect,
      });
      return { status: 'created', asset: this.mapAsset(asset) };
    } catch (error) {
      if (this.prismaErrorCode(error) !== 'P2002') throw error;

      const existing = await this.prisma.mediaAsset.findUnique({
        where: {
          ownerId_clientUploadId: {
            ownerId: input.ownerId.toLowerCase(),
            clientUploadId: input.clientUploadId.toLowerCase(),
          },
        },
        select: mediaAssetSelect,
      });
      if (!existing) throw error;
      if (existing.uploadFingerprint !== input.uploadFingerprint) {
        return { status: 'idempotency-conflict' };
      }
      return { status: 'existing', asset: this.mapAsset(existing) };
    }
  }

  async findForOwner(
    id: string,
    ownerId: string,
  ): Promise<MediaAssetRecord | null> {
    const asset = await this.prisma.mediaAsset.findFirst({
      where: {
        id: id.toLowerCase(),
        ownerId: ownerId.toLowerCase(),
        purpose: { in: [...supportedMediaPurposes] },
      },
      select: mediaAssetSelect,
    });
    return asset ? this.mapAsset(asset) : null;
  }

  async completePending(
    input: CompletePendingMediaInput,
  ): Promise<CompletePendingMediaResult> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.mediaAsset.updateMany({
        where: {
          id: input.id.toLowerCase(),
          ownerId: input.ownerId.toLowerCase(),
          purpose: { in: [...supportedMediaPurposes] },
          status: MediaStatus.PENDING,
          expiresAt: { gt: input.now },
        },
        data: {
          status: MediaStatus.READY,
          cloudinaryAssetId: input.cloudinaryAssetId,
          format: input.format,
          byteSize: input.byteSize,
          width: input.width,
          height: input.height,
          durationMs: input.durationMs,
          secureUrl: input.secureUrl,
          etag: input.etag,
          completedAt: input.now,
        },
      });
      const asset = await transaction.mediaAsset.findFirst({
        where: {
          id: input.id.toLowerCase(),
          ownerId: input.ownerId.toLowerCase(),
          purpose: { in: [...supportedMediaPurposes] },
        },
        select: mediaAssetSelect,
      });
      if (!asset) return { status: 'not-found' } as const;
      const mappedAsset = this.mapAsset(asset);
      if (updated.count === 0) {
        if (
          asset.status === MediaStatus.PENDING &&
          asset.expiresAt.getTime() <= input.now.getTime()
        ) {
          return { status: 'expired', asset: mappedAsset } as const;
        }
        return { status: 'not-pending', asset: mappedAsset } as const;
      }
      return { status: 'ready', asset: mappedAsset } as const;
    });
  }

  async failPending(id: string, ownerId: string, now: Date): Promise<boolean> {
    const result = await this.prisma.mediaAsset.updateMany({
      where: {
        id: id.toLowerCase(),
        ownerId: ownerId.toLowerCase(),
        purpose: { in: [...supportedMediaPurposes] },
        status: MediaStatus.PENDING,
      },
      data: { status: MediaStatus.FAILED, failedAt: now },
    });
    return result.count === 1;
  }

  async setProfileAvatar(
    ownerId: string,
    mediaId: string,
  ): Promise<SetProfileAvatarResult> {
    const normalizedOwnerId = ownerId.toLowerCase();
    const normalizedMediaId = mediaId.toLowerCase();
    return this.prisma.$transaction(async (transaction) => {
      const asset = await transaction.mediaAsset.findFirst({
        where: {
          id: normalizedMediaId,
          ownerId: normalizedOwnerId,
          purpose: MediaPurpose.PROFILE_AVATAR,
          resourceType: 'image',
        },
        select: { id: true, status: true, secureUrl: true },
      });
      if (!asset) return { status: 'media-not-found' } as const;
      if (asset.status !== MediaStatus.READY || !asset.secureUrl) {
        return { status: 'media-not-ready' } as const;
      }

      const user = await transaction.user.update({
        where: { id: normalizedOwnerId },
        data: {
          avatarMediaId: asset.id,
          avatarUrl: asset.secureUrl,
        },
        select: mediaProfileUserSelect,
      });
      return { status: 'updated', user } as const;
    });
  }

  async clearProfileAvatar(
    ownerId: string,
  ): Promise<MediaProfileUserRecord | null> {
    try {
      return await this.prisma.user.update({
        where: { id: ownerId.toLowerCase() },
        data: { avatarMediaId: null, avatarUrl: null },
        select: mediaProfileUserSelect,
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2025') return null;
      throw error;
    }
  }

  private mapAsset(asset: SelectedMediaAsset): MediaAssetRecord {
    const purpose =
      asset.purpose === MediaPurpose.PROFILE_AVATAR
        ? ('PROFILE_AVATAR' as const)
        : asset.purpose === MediaPurpose.MESSAGE_ATTACHMENT
          ? ('MESSAGE_ATTACHMENT' as const)
          : null;
    if (
      !purpose ||
      (asset.resourceType !== 'image' && asset.resourceType !== 'video') ||
      asset.deliveryType !== 'upload' ||
      (purpose === 'PROFILE_AVATAR' && asset.resourceType !== 'image')
    ) {
      throw new Error('Media invariants are invalid.');
    }
    return {
      ...asset,
      purpose,
      status: asset.status,
      resourceType: asset.resourceType,
      deliveryType: 'upload',
    };
  }

  private prismaErrorCode(error: unknown): string | null {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : null;
  }
}

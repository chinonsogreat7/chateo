import { Injectable } from '@nestjs/common';
import { MediaPurpose, MediaStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { serializable } from '../common/serializable';
import {
  MediaCleanupRepository,
  type FindMediaCleanupCandidatesInput,
  type MediaCleanupCandidate,
  type TransitionMediaCleanupInput,
} from './media-cleanup.repository';

const supportedMediaPurposes = [
  MediaPurpose.PROFILE_AVATAR,
  MediaPurpose.GROUP_AVATAR,
  MediaPurpose.MESSAGE_ATTACHMENT,
] as const;

@Injectable()
export class PrismaMediaCleanupRepository extends MediaCleanupRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findCandidates(
    input: FindMediaCleanupCandidatesInput,
  ): Promise<MediaCleanupCandidate[]> {
    const assets = await this.prisma.mediaAsset.findMany({
      where: {
        purpose: { in: [...supportedMediaPurposes] },
        ...(input.unusedBefore
          ? {
              OR: [
                { status: { in: [MediaStatus.PENDING, MediaStatus.FAILED] } },
                {
                  status: MediaStatus.READY,
                  completedAt: { not: null },
                  messageClaimedAt: null,
                  profileAvatarFor: { is: null },
                  groupAvatars: { none: {} },
                  messageAttachments: { none: {} },
                  OR: [
                    { unusedSince: null },
                    { unusedSince: { lte: input.unusedBefore } },
                  ],
                },
              ],
            }
          : { status: { in: [MediaStatus.PENDING, MediaStatus.FAILED] } }),
        resourceType: { in: ['image', 'video', 'raw'] },
        deliveryType: 'upload',
        createdAt: { lte: input.signatureIssuedBefore },
        expiresAt: { lte: input.expiredBefore },
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: input.limit,
      select: {
        id: true,
        cloudinaryPublicId: true,
        resourceType: true,
        status: true,
      },
    });

    return assets.map((asset) => ({
      id: asset.id,
      cloudinaryPublicId: asset.cloudinaryPublicId,
      resourceType:
        asset.resourceType === 'raw'
          ? ('raw' as const)
          : asset.resourceType === 'video'
            ? ('video' as const)
            : ('image' as const),
      status:
        asset.status === MediaStatus.PENDING
          ? ('PENDING' as const)
          : asset.status === MediaStatus.READY
            ? ('READY' as const)
            : ('FAILED' as const),
    }));
  }

  async claimExpiredPending(
    input: TransitionMediaCleanupInput,
  ): Promise<boolean> {
    const result = await this.prisma.mediaAsset.updateMany({
      where: {
        id: input.id.toLowerCase(),
        purpose: { in: [...supportedMediaPurposes] },
        status: MediaStatus.PENDING,
        resourceType: { in: ['image', 'video', 'raw'] },
        deliveryType: 'upload',
        createdAt: { lte: input.signatureIssuedBefore },
        expiresAt: { lte: input.expiredBefore },
      },
      data: {
        status: MediaStatus.FAILED,
        failedAt: input.now,
      },
    });
    return result.count === 1;
  }

  async markDeleted(input: TransitionMediaCleanupInput): Promise<boolean> {
    const result = await this.prisma.mediaAsset.updateMany({
      where: {
        id: input.id.toLowerCase(),
        purpose: { in: [...supportedMediaPurposes] },
        status: MediaStatus.FAILED,
        resourceType: { in: ['image', 'video', 'raw'] },
        deliveryType: 'upload',
        createdAt: { lte: input.signatureIssuedBefore },
        expiresAt: { lte: input.expiredBefore },
      },
      data: {
        status: MediaStatus.DELETED,
        deletedAt: input.now,
      },
    });
    return result.count === 1;
  }

  async claimUnusedReady(input: TransitionMediaCleanupInput): Promise<boolean> {
    if (!input.unusedBefore) return false;
    return serializable(this.prisma, async (tx) => {
      // This write competes with the guarded media-row writes used by avatar
      // assignment and message claims. No provider deletion happens until commit.
      const where = {
        id: input.id.toLowerCase(),
        status: MediaStatus.READY,
        purpose: { in: [...supportedMediaPurposes] },
        resourceType: { in: ['image', 'video', 'raw'] },
        deliveryType: 'upload',
        createdAt: { lte: input.signatureIssuedBefore },
        expiresAt: { lte: input.expiredBefore },
        completedAt: { not: null },
        messageClaimedAt: null,
        deletedAt: null,
        profileAvatarFor: { is: null },
        groupAvatars: { none: {} },
        messageAttachments: { none: {} },
      };
      const asset = await tx.mediaAsset.findFirst({
        where,
        select: { secureUrl: true, unusedSince: true },
      });
      if (!asset) return false;
      // Preserve legacy avatars whose URL predates the verified media FK.
      if (asset.secureUrl) {
        const [profile, group] = await Promise.all([
          tx.user.findFirst({
            where: { avatarUrl: asset.secureUrl },
            select: { id: true },
          }),
          tx.conversation.findFirst({
            where: { avatarUrl: asset.secureUrl },
            select: { id: true },
          }),
        ]);
        if (profile || group) {
          await tx.mediaAsset.updateMany({
            where,
            data: { unusedSince: null, updatedAt: input.now },
          });
          return false;
        }
      }
      if (!asset.unusedSince) {
        await tx.mediaAsset.updateMany({
          where,
          data: { unusedSince: input.now, updatedAt: input.now },
        });
        return false;
      }
      if (asset.unusedSince > input.unusedBefore!) return false;
      const result = await tx.mediaAsset.updateMany({
        where: { ...where, unusedSince: { lte: input.unusedBefore } },
        data: { status: MediaStatus.FAILED, failedAt: input.now },
      });
      return result.count === 1;
    });
  }
}

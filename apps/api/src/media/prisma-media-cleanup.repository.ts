import { Injectable } from '@nestjs/common';
import { MediaPurpose, MediaStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  MediaCleanupRepository,
  type FindMediaCleanupCandidatesInput,
  type MediaCleanupCandidate,
  type TransitionMediaCleanupInput,
} from './media-cleanup.repository';

const supportedMediaPurposes = [
  MediaPurpose.PROFILE_AVATAR,
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
        status: { in: [MediaStatus.PENDING, MediaStatus.FAILED] },
        resourceType: { in: ['image', 'video'] },
        deliveryType: 'upload',
        createdAt: { lte: input.signatureIssuedBefore },
        expiresAt: { lte: input.expiredBefore },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
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
        asset.resourceType === 'video'
          ? ('video' as const)
          : ('image' as const),
      status:
        asset.status === MediaStatus.PENDING
          ? ('PENDING' as const)
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
        resourceType: { in: ['image', 'video'] },
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
        resourceType: { in: ['image', 'video'] },
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
}

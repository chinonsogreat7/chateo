import { MediaPurpose, MediaStatus } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaMediaCleanupRepository } from './prisma-media-cleanup.repository';

const MEDIA_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-06T12:00:00.000Z');
const SIGNATURE_SAFE_CUTOFF = new Date('2026-09-06T10:55:00.000Z');

function createRepository() {
  const findMany = jest.fn();
  const updateMany = jest.fn();
  const prisma = {
    mediaAsset: { findMany, updateMany },
  } as unknown as PrismaService;

  return {
    repository: new PrismaMediaCleanupRepository(prisma),
    findMany,
    updateMany,
  };
}

describe('PrismaMediaCleanupRepository', () => {
  it('observes detached ready media for a full grace period before atomically retiring it', async () => {
    const asset = {
      unusedSince: null as Date | null,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
    };
    const tx = {
      mediaAsset: {
        findFirst: jest.fn().mockResolvedValue(asset),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      conversation: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const transaction = jest.fn(
      async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    );
    const repository = new PrismaMediaCleanupRepository({
      $transaction: transaction,
    } as unknown as PrismaService);
    const input = {
      id: MEDIA_ID,
      signatureIssuedBefore: SIGNATURE_SAFE_CUTOFF,
      expiredBefore: NOW,
      unusedBefore: new Date(NOW.getTime() - 86400000),
      now: NOW,
    };
    await expect(repository.claimUnusedReady(input)).resolves.toBe(false);
    expect(tx.mediaAsset.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { unusedSince: NOW, updatedAt: NOW } }),
    );
    asset.unusedSince = new Date(input.unusedBefore.getTime() - 1);
    await expect(repository.claimUnusedReady(input)).resolves.toBe(true);
    expect(tx.mediaAsset.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'READY',
          messageClaimedAt: null,
          profileAvatarFor: { is: null },
          groupAvatars: { none: {} },
          messageAttachments: { none: {} },
          unusedSince: { lte: input.unusedBefore },
        }),
        data: { status: 'FAILED', failedAt: NOW },
      }),
    );
    tx.user.findFirst.mockResolvedValue({ id: 'legacy-owner' });
    await expect(repository.claimUnusedReady(input)).resolves.toBe(false);
    expect(tx.mediaAsset.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { unusedSince: null, updatedAt: NOW } }),
    );
    tx.mediaAsset.findFirst.mockResolvedValue(null);
    await expect(repository.claimUnusedReady(input)).resolves.toBe(false);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
  });

  it('selects supported expired media uploads beyond the signature safety window', async () => {
    const { repository, findMany } = createRepository();
    findMany.mockResolvedValue([
      {
        id: MEDIA_ID,
        cloudinaryPublicId: 'chateo/profile-avatars/media-id',
        resourceType: 'image',
        status: MediaStatus.FAILED,
      },
    ]);

    await expect(
      repository.findCandidates({
        signatureIssuedBefore: SIGNATURE_SAFE_CUTOFF,
        expiredBefore: NOW,
        limit: 50,
      }),
    ).resolves.toEqual([
      {
        id: MEDIA_ID,
        cloudinaryPublicId: 'chateo/profile-avatars/media-id',
        resourceType: 'image',
        status: 'FAILED',
      },
    ]);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          purpose: {
            in: [
              MediaPurpose.PROFILE_AVATAR,
              MediaPurpose.GROUP_AVATAR,
              MediaPurpose.MESSAGE_ATTACHMENT,
            ],
          },
          status: { in: [MediaStatus.PENDING, MediaStatus.FAILED] },
          resourceType: { in: ['image', 'video', 'raw'] },
          createdAt: { lte: SIGNATURE_SAFE_CUTOFF },
          expiresAt: { lte: NOW },
        }),
        take: 50,
      }),
    );
  });

  it('preserves the video resource type for audio cleanup routing', async () => {
    const { repository, findMany } = createRepository();
    findMany.mockResolvedValue([
      {
        id: MEDIA_ID,
        cloudinaryPublicId: 'chateo/message-audio/media-id',
        resourceType: 'video',
        status: MediaStatus.PENDING,
      },
    ]);

    await expect(
      repository.findCandidates({
        signatureIssuedBefore: SIGNATURE_SAFE_CUTOFF,
        expiredBefore: NOW,
        limit: 50,
      }),
    ).resolves.toEqual([
      {
        id: MEDIA_ID,
        cloudinaryPublicId: 'chateo/message-audio/media-id',
        resourceType: 'video',
        status: 'PENDING',
      },
    ]);
  });

  it('claims pending work and marks provider-confirmed deletion with CAS updates', async () => {
    const { repository, updateMany } = createRepository();
    updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({
      count: 1,
    });
    const transition = {
      id: MEDIA_ID,
      signatureIssuedBefore: SIGNATURE_SAFE_CUTOFF,
      expiredBefore: NOW,
      now: NOW,
    };

    await expect(repository.claimExpiredPending(transition)).resolves.toBe(
      true,
    );
    await expect(repository.markDeleted(transition)).resolves.toBe(true);

    expect(updateMany.mock.calls[0]?.[0]).toMatchObject({
      where: {
        id: MEDIA_ID,
        purpose: {
          in: [
            MediaPurpose.PROFILE_AVATAR,
            MediaPurpose.GROUP_AVATAR,
            MediaPurpose.MESSAGE_ATTACHMENT,
          ],
        },
        status: MediaStatus.PENDING,
        createdAt: { lte: SIGNATURE_SAFE_CUTOFF },
        expiresAt: { lte: NOW },
      },
      data: { status: MediaStatus.FAILED, failedAt: NOW },
    });
    expect(updateMany.mock.calls[1]?.[0]).toMatchObject({
      where: {
        id: MEDIA_ID,
        purpose: {
          in: [
            MediaPurpose.PROFILE_AVATAR,
            MediaPurpose.GROUP_AVATAR,
            MediaPurpose.MESSAGE_ATTACHMENT,
          ],
        },
        status: MediaStatus.FAILED,
        createdAt: { lte: SIGNATURE_SAFE_CUTOFF },
        expiresAt: { lte: NOW },
      },
      data: { status: MediaStatus.DELETED, deletedAt: NOW },
    });
  });
});

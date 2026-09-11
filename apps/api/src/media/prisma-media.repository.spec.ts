import { MediaPurpose, MediaStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { CreatePendingMediaInput } from './media.repository';
import { PrismaMediaRepository } from './prisma-media.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_UPLOAD_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-06T12:00:00.000Z');

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function pendingAsset(
  overrides: Partial<ReturnType<typeof basePendingAsset>> = {},
) {
  return { ...basePendingAsset(), ...overrides };
}

function basePendingAsset() {
  return {
    id: MEDIA_ID,
    ownerId: USER_ID,
    clientUploadId: CLIENT_UPLOAD_ID,
    purpose: MediaPurpose.PROFILE_AVATAR as MediaPurpose,
    status: MediaStatus.PENDING as MediaStatus,
    uploadFingerprint: 'f'.repeat(64),
    contentSha256: null,
    cloudinaryPublicId: `chateo/profile-avatars/${MEDIA_ID}`,
    cloudinaryAssetId: null as string | null,
    resourceType: 'image',
    deliveryType: 'upload',
    format: null as string | null,
    mimeType: 'image/jpeg',
    byteSize: 245000,
    width: null as number | null,
    height: null as number | null,
    durationMs: null as number | null,
    originalFilename: null as string | null,
    secureUrl: null as string | null,
    etag: null as string | null,
    expiresAt: NOW,
    completedAt: null as Date | null,
    failedAt: null as Date | null,
    deletedAt: null as Date | null,
    createdAt: new Date('2026-09-06T11:50:00.000Z'),
    updatedAt: NOW,
  };
}

function createInput(
  overrides: Partial<CreatePendingMediaInput> = {},
): CreatePendingMediaInput {
  return {
    id: MEDIA_ID.toUpperCase(),
    ownerId: USER_ID.toUpperCase(),
    clientUploadId: CLIENT_UPLOAD_ID.toUpperCase(),
    purpose: 'PROFILE_AVATAR',
    uploadFingerprint: 'f'.repeat(64),
    contentSha256: 'a'.repeat(64),
    cloudinaryPublicId: `chateo/profile-avatars/${MEDIA_ID}`,
    resourceType: 'image',
    deliveryType: 'upload',
    mimeType: 'image/jpeg',
    byteSize: 245000,
    originalFilename: 'avatar.jpg',
    expiresAt: new Date('2026-09-06T12:10:00.000Z'),
    now: NOW,
    ...overrides,
  };
}

function createRepository() {
  const mediaCreate = jest.fn();
  const mediaFindUnique = jest.fn();
  const mediaFindFirst = jest.fn();
  const mediaUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const userUpdate = jest.fn();
  const transactionClient = {
    mediaAsset: {
      findFirst: mediaFindFirst,
      updateMany: mediaUpdateMany,
    },
    user: { update: userUpdate },
  };
  const transaction = jest.fn(
    async (operation: (client: unknown) => Promise<unknown>) =>
      operation(transactionClient),
  );
  const prisma = {
    mediaAsset: {
      create: mediaCreate,
      findUnique: mediaFindUnique,
      findFirst: mediaFindFirst,
      updateMany: mediaUpdateMany,
    },
    user: { update: userUpdate },
    $transaction: transaction,
  } as unknown as PrismaService;

  return {
    repository: new PrismaMediaRepository(prisma),
    mediaCreate,
    mediaFindUnique,
    mediaFindFirst,
    mediaUpdateMany,
    userUpdate,
    transaction,
  };
}

describe('PrismaMediaRepository', () => {
  it('does not assign an avatar that a cleanup worker already retired', async () => {
    const { repository, mediaFindFirst, mediaUpdateMany, userUpdate } =
      createRepository();
    mediaFindFirst.mockResolvedValue({
      id: MEDIA_ID,
      status: 'READY',
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
    });
    mediaUpdateMany.mockResolvedValue({ count: 0 });
    await expect(
      repository.setProfileAvatar(USER_ID, MEDIA_ID),
    ).resolves.toEqual({ status: 'media-not-ready' });
    expect(userUpdate).not.toHaveBeenCalled();
  });
  it('creates a normalized pending profile-avatar record', async () => {
    const { repository, mediaCreate } = createRepository();
    mediaCreate.mockResolvedValue(pendingAsset());

    await expect(
      repository.createPending(createInput()),
    ).resolves.toMatchObject({
      status: 'created',
      asset: {
        id: MEDIA_ID,
        ownerId: USER_ID,
        clientUploadId: CLIENT_UPLOAD_ID,
        status: 'PENDING',
      },
    });
    expect(mediaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: MEDIA_ID,
          ownerId: USER_ID,
          clientUploadId: CLIENT_UPLOAD_ID,
          purpose: MediaPurpose.PROFILE_AVATAR,
          status: MediaStatus.PENDING,
        }),
      }),
    );
  });

  it.each([
    [MediaPurpose.MESSAGE_ATTACHMENT, 'message-images'],
    [MediaPurpose.GROUP_AVATAR, 'group-avatars'],
  ] as const)('persists and maps the %s purpose', async (purpose, folder) => {
    const { repository, mediaCreate } = createRepository();
    mediaCreate.mockResolvedValue(
      pendingAsset({
        purpose,
        cloudinaryPublicId: `chateo/${folder}/${MEDIA_ID}`,
      }),
    );

    await expect(
      repository.createPending(
        createInput({
          purpose,
          cloudinaryPublicId: `chateo/${folder}/${MEDIA_ID}`,
        }),
      ),
    ).resolves.toMatchObject({
      status: 'created',
      asset: { purpose },
    });
    expect(mediaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          purpose,
          cloudinaryPublicId: `chateo/${folder}/${MEDIA_ID}`,
        }),
      }),
    );
  });

  it('persists and maps a Cloudinary video resource for chat audio', async () => {
    const { repository, mediaCreate } = createRepository();
    mediaCreate.mockResolvedValue(
      pendingAsset({
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        cloudinaryPublicId: `chateo/message-audio/${MEDIA_ID}`,
        resourceType: 'video',
        mimeType: 'audio/mp4',
        byteSize: 800000,
        originalFilename: 'voice-note.m4a',
      }),
    );

    await expect(
      repository.createPending(
        createInput({
          purpose: 'MESSAGE_ATTACHMENT',
          cloudinaryPublicId: `chateo/message-audio/${MEDIA_ID}`,
          resourceType: 'video',
          mimeType: 'audio/mp4',
          byteSize: 800000,
          originalFilename: 'voice-note.m4a',
        }),
      ),
    ).resolves.toMatchObject({
      status: 'created',
      asset: {
        purpose: 'MESSAGE_ATTACHMENT',
        resourceType: 'video',
        mimeType: 'audio/mp4',
      },
    });
    expect(mediaCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          resourceType: 'video',
          mimeType: 'audio/mp4',
        }),
      }),
    );
  });

  it.each([
    ['matching fingerprint', 'existing'],
    ['different fingerprint', 'idempotency-conflict'],
  ] as const)(
    'maps a unique-key race with a %s to %s',
    async (fingerprintCase, expectedStatus) => {
      const { repository, mediaCreate, mediaFindUnique } = createRepository();
      mediaCreate.mockRejectedValue(knownRequestError('P2002'));
      mediaFindUnique.mockResolvedValue({
        ...pendingAsset(),
        uploadFingerprint:
          fingerprintCase === 'matching fingerprint'
            ? 'f'.repeat(64)
            : '0'.repeat(64),
      });

      await expect(
        repository.createPending(createInput()),
      ).resolves.toMatchObject({ status: expectedStatus });
      expect(mediaFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            ownerId_clientUploadId: {
              ownerId: USER_ID,
              clientUploadId: CLIENT_UPLOAD_ID,
            },
          },
        }),
      );
    },
  );

  it('uses an owner- and purpose-scoped lookup to prevent media enumeration', async () => {
    const { repository, mediaFindFirst } = createRepository();
    mediaFindFirst.mockResolvedValue(pendingAsset());

    await expect(
      repository.findForOwner(MEDIA_ID.toUpperCase(), USER_ID.toUpperCase()),
    ).resolves.toMatchObject({ id: MEDIA_ID, ownerId: USER_ID });
    expect(mediaFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: MEDIA_ID,
          ownerId: USER_ID,
          purpose: {
            in: [
              MediaPurpose.PROFILE_AVATAR,
              MediaPurpose.GROUP_AVATAR,
              MediaPurpose.MESSAGE_ATTACHMENT,
            ],
          },
        },
      }),
    );
  });

  it('returns expired when the atomic ready transition loses to expiry', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const findFirst = jest.fn().mockResolvedValue(pendingAsset());
    const transaction = jest.fn(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ mediaAsset: { updateMany, findFirst } }),
    );
    const repository = new PrismaMediaRepository({
      $transaction: transaction,
    } as unknown as PrismaService);

    await expect(
      repository.completePending({
        id: MEDIA_ID,
        ownerId: USER_ID,
        cloudinaryAssetId: 'cloudinary-asset-id',
        format: 'jpg',
        byteSize: 100000,
        width: 640,
        height: 640,
        durationMs: null,
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
        etag: null,
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'expired' });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: MediaStatus.PENDING,
          expiresAt: { gt: NOW },
        }),
      }),
    );
  });

  it('maps an owned message attachment from the shared media lookup', async () => {
    const { repository, mediaFindFirst } = createRepository();
    mediaFindFirst.mockResolvedValue(
      pendingAsset({
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        cloudinaryPublicId: `chateo/message-images/${MEDIA_ID}`,
      }),
    );

    await expect(
      repository.findForOwner(MEDIA_ID, USER_ID),
    ).resolves.toMatchObject({
      id: MEDIA_ID,
      purpose: 'MESSAGE_ATTACHMENT',
    });
  });

  it('persists provider-normalized size and metadata in an atomic ready transition', async () => {
    const { repository, mediaFindFirst, mediaUpdateMany } = createRepository();
    mediaUpdateMany.mockResolvedValue({ count: 1 });
    mediaFindFirst.mockResolvedValue({
      ...pendingAsset(),
      status: MediaStatus.READY,
      cloudinaryAssetId: 'cloudinary-asset-id',
      format: 'jpg',
      byteSize: 120000,
      width: 640,
      height: 480,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
      completedAt: NOW,
    });

    await expect(
      repository.completePending({
        id: MEDIA_ID.toUpperCase(),
        ownerId: USER_ID.toUpperCase(),
        cloudinaryAssetId: 'cloudinary-asset-id',
        format: 'jpg',
        byteSize: 120000,
        width: 640,
        height: 480,
        durationMs: null,
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
        etag: 'etag',
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      asset: { status: 'READY', byteSize: 120000 },
    });
    expect(mediaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: MEDIA_ID,
          ownerId: USER_ID,
          status: MediaStatus.PENDING,
          expiresAt: { gt: NOW },
        }),
        data: expect.objectContaining({
          status: MediaStatus.READY,
          byteSize: 120000,
          completedAt: NOW,
        }),
      }),
    );
  });

  it('persists audio duration while keeping image dimensions null', async () => {
    const { repository, mediaFindFirst, mediaUpdateMany } = createRepository();
    mediaUpdateMany.mockResolvedValue({ count: 1 });
    mediaFindFirst.mockResolvedValue(
      pendingAsset({
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status: MediaStatus.READY,
        resourceType: 'video',
        mimeType: 'audio/mp4',
        cloudinaryPublicId: `chateo/message-audio/${MEDIA_ID}`,
        cloudinaryAssetId: 'cloudinary-audio-asset-id',
        format: 'm4a',
        byteSize: 750000,
        width: null,
        height: null,
        durationMs: 12345,
        secureUrl:
          'https://res.cloudinary.com/demo/video/upload/voice-note.m4a',
        completedAt: NOW,
      }),
    );

    await expect(
      repository.completePending({
        id: MEDIA_ID,
        ownerId: USER_ID,
        cloudinaryAssetId: 'cloudinary-audio-asset-id',
        format: 'm4a',
        byteSize: 750000,
        width: null,
        height: null,
        durationMs: 12345,
        secureUrl:
          'https://res.cloudinary.com/demo/video/upload/voice-note.m4a',
        etag: 'audio-etag',
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'ready',
      asset: {
        resourceType: 'video',
        width: null,
        height: null,
        durationMs: 12345,
      },
    });
    expect(mediaUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          width: null,
          height: null,
          durationMs: 12345,
        }),
      }),
    );
  });

  it('uses a compare-and-set update when marking rejected media', async () => {
    const { repository, mediaUpdateMany } = createRepository();
    mediaUpdateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({
      count: 0,
    });

    await expect(
      repository.failPending(
        MEDIA_ID.toUpperCase(),
        USER_ID.toUpperCase(),
        NOW,
      ),
    ).resolves.toBe(true);
    await expect(repository.failPending(MEDIA_ID, USER_ID, NOW)).resolves.toBe(
      false,
    );
    expect(mediaUpdateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: MEDIA_ID,
        ownerId: USER_ID,
        purpose: {
          in: [
            MediaPurpose.PROFILE_AVATAR,
            MediaPurpose.GROUP_AVATAR,
            MediaPurpose.MESSAGE_ATTACHMENT,
          ],
        },
        status: MediaStatus.PENDING,
      },
      data: { status: MediaStatus.FAILED, failedAt: NOW },
    });
  });

  it('selects only a ready owned profile avatar before updating the user', async () => {
    const { repository, mediaFindFirst, userUpdate, transaction } =
      createRepository();
    mediaFindFirst.mockResolvedValue({
      id: MEDIA_ID,
      status: MediaStatus.READY,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
    });
    userUpdate.mockResolvedValue({
      id: USER_ID,
      phoneNumber: '+2348012345678',
      displayName: 'Ada',
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
      profileCompletedAt: NOW,
      createdAt: NOW,
    });

    await expect(
      repository.setProfileAvatar(
        USER_ID.toUpperCase(),
        MEDIA_ID.toUpperCase(),
      ),
    ).resolves.toMatchObject({
      status: 'updated',
      user: { id: USER_ID },
    });
    expect(mediaFindFirst).toHaveBeenCalledWith({
      where: {
        id: MEDIA_ID,
        ownerId: USER_ID,
        purpose: MediaPurpose.PROFILE_AVATAR,
        resourceType: 'image',
      },
      select: { id: true, status: true, secureUrl: true },
    });
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: {
          avatarMediaId: MEDIA_ID,
          avatarUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
        },
      }),
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it.each([
    [null, 'media-not-found'],
    [
      { id: MEDIA_ID, status: MediaStatus.PENDING, secureUrl: null },
      'media-not-ready',
    ],
  ] as const)(
    'does not update the user for unavailable avatar media %#',
    async (storedAsset, expectedStatus) => {
      const { repository, mediaFindFirst, userUpdate } = createRepository();
      mediaFindFirst.mockResolvedValue(storedAsset);

      await expect(
        repository.setProfileAvatar(USER_ID, MEDIA_ID),
      ).resolves.toEqual({ status: expectedStatus });
      expect(userUpdate).not.toHaveBeenCalled();
    },
  );

  it('clears profile media id and URL idempotently', async () => {
    const { repository, userUpdate } = createRepository();
    userUpdate.mockResolvedValue({
      id: USER_ID,
      phoneNumber: '+2348012345678',
      displayName: 'Ada',
      avatarUrl: null,
      profileCompletedAt: NOW,
      createdAt: NOW,
    });

    await expect(
      repository.clearProfileAvatar(USER_ID.toUpperCase()),
    ).resolves.toMatchObject({ id: USER_ID, avatarUrl: null });
    expect(userUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: USER_ID },
        data: { avatarMediaId: null, avatarUrl: null },
      }),
    );

    userUpdate.mockRejectedValueOnce(knownRequestError('P2025'));
    await expect(repository.clearProfileAvatar(USER_ID)).resolves.toBeNull();
  });
});

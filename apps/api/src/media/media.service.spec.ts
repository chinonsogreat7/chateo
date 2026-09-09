import { HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/errors/api.exception';
import { MediaClock } from './media-clock';
import { MediaRepository } from './media.repository';
import { MediaService } from './media.service';
import {
  MediaStorageError,
  MediaStorageProvider,
} from './media-storage.provider';
import type {
  MediaAssetRecord,
  StoredAudioResource,
  StoredImageResource,
} from './media.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const MEDIA_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_UPLOAD_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-09-06T10:00:00.000Z');

function asset(overrides: Partial<MediaAssetRecord> = {}): MediaAssetRecord {
  return {
    id: MEDIA_ID,
    ownerId: USER_ID,
    clientUploadId: CLIENT_UPLOAD_ID,
    purpose: 'PROFILE_AVATAR',
    status: 'PENDING',
    uploadFingerprint: 'f'.repeat(64),
    contentSha256: null,
    cloudinaryPublicId: `chateo/profile-avatars/${MEDIA_ID}`,
    cloudinaryAssetId: null,
    resourceType: 'image',
    deliveryType: 'upload',
    format: null,
    mimeType: 'image/jpeg',
    byteSize: 245000,
    width: null,
    height: null,
    durationMs: null,
    originalFilename: 'avatar.jpg',
    secureUrl: null,
    etag: null,
    expiresAt: new Date('2026-09-06T10:10:00.000Z'),
    completedAt: null,
    failedAt: null,
    deletedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resource(
  mediaAsset: MediaAssetRecord,
  overrides: Partial<StoredImageResource> = {},
): StoredImageResource {
  return {
    assetId: 'cloudinary-asset-id',
    publicId: mediaAsset.cloudinaryPublicId,
    resourceType: 'image',
    deliveryType: 'upload',
    format: 'jpg',
    byteSize: mediaAsset.byteSize,
    width: 640,
    height: 640,
    secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
    etag: 'etag',
    context: {
      media_id: mediaAsset.id,
      upload_fingerprint: mediaAsset.uploadFingerprint,
    },
    ...overrides,
  };
}

function audioResource(
  mediaAsset: MediaAssetRecord,
  overrides: Partial<StoredAudioResource> = {},
): StoredAudioResource {
  return {
    assetId: 'cloudinary-audio-asset-id',
    publicId: mediaAsset.cloudinaryPublicId,
    resourceType: 'video',
    deliveryType: 'upload',
    format: 'm4a',
    byteSize: mediaAsset.byteSize,
    durationSeconds: 12.345,
    secureUrl: 'https://res.cloudinary.com/demo/video/upload/voice-note.m4a',
    etag: 'audio-etag',
    context: {
      media_id: mediaAsset.id,
      upload_fingerprint: mediaAsset.uploadFingerprint,
    },
    ...overrides,
  };
}

function createService(
  configValues: Record<string, unknown> = {},
  currentTime: Date = NOW,
) {
  const effectiveConfigValues: Record<string, unknown> = {
    MEDIA_UPLOADS_ENABLED: true,
    ...configValues,
  };
  const repository: jest.Mocked<MediaRepository> = {
    createPending: jest.fn(),
    findForOwner: jest.fn(),
    completePending: jest.fn(),
    failPending: jest.fn().mockResolvedValue(true),
    setProfileAvatar: jest.fn(),
    clearProfileAvatar: jest.fn(),
  };
  const storage: jest.Mocked<MediaStorageProvider> = {
    signImageUpload: jest.fn(),
    signAudioUpload: jest.fn(),
    findImage: jest.fn(),
    findAudio: jest.fn(),
    deleteImage: jest.fn(),
    deleteAudio: jest.fn(),
  };
  const clock: MediaClock = { now: () => new Date(currentTime.getTime()) };
  const config = {
    get: jest.fn((key: string, defaultValue: unknown) =>
      Object.hasOwn(effectiveConfigValues, key)
        ? effectiveConfigValues[key]
        : defaultValue,
    ),
  } as unknown as ConfigService;
  return {
    repository,
    storage,
    clock,
    config,
    service: new MediaService(repository, storage, clock, config),
  };
}

async function expectApiError(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => new Error(`Expected ${code}, but the operation resolved.`),
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiException);
  expect((error as ApiException).getStatus()).toBe(status);
  expect((error as ApiException).getResponse()).toMatchObject({ code });
}

describe('MediaService', () => {
  it('rejects disabled uploads before creating a database record', async () => {
    const { repository, storage, service } = createService({
      MEDIA_UPLOADS_ENABLED: false,
    });

    await expectApiError(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'profile_avatar',
        contentType: 'image/jpeg',
        sizeBytes: 245000,
      }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'MEDIA_UPLOADS_DISABLED',
    );
    expect(repository.createPending).not.toHaveBeenCalled();
    expect(storage.signImageUpload).not.toHaveBeenCalled();
  });

  it('creates a server-owned Cloudinary path and signs only private-neutral context', async () => {
    const { repository, storage, service } = createService();
    repository.createPending.mockImplementation(async (input) => ({
      status: 'created',
      asset: asset({
        id: input.id,
        cloudinaryPublicId: input.cloudinaryPublicId,
        uploadFingerprint: input.uploadFingerprint,
      }),
    }));
    storage.signImageUpload.mockResolvedValue({
      url: 'https://api.cloudinary.com/v1_1/demo/image/upload',
      method: 'POST',
      fields: {
        api_key: 'public-key',
        timestamp: '1788688800',
        signature: 'signature',
        public_id: 'public-id',
        context: 'context',
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'jpg,jpeg,png,webp',
        upload_preset: 'chateo_profile_avatars',
        transformation: 'c_limit,h_2048,w_2048/q_auto',
      },
    });

    const result = await service.createUpload(USER_ID, {
      clientUploadId: CLIENT_UPLOAD_ID,
      purpose: 'profile_avatar',
      contentType: 'image/jpeg',
      sizeBytes: 245000,
      originalFilename: 'avatar.jpg',
    });

    const createInput = repository.createPending.mock.calls[0]?.[0];
    expect(createInput?.cloudinaryPublicId).toMatch(
      /^chateo\/profile-avatars\/[0-9a-f-]{36}$/,
    );
    expect(createInput?.cloudinaryPublicId).not.toContain(USER_ID);
    expect(createInput?.uploadFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(storage.signImageUpload).toHaveBeenCalledWith({
      publicId: createInput?.cloudinaryPublicId,
      timestamp: NOW,
      context: {
        media_id: createInput?.id,
        upload_fingerprint: createInput?.uploadFingerprint,
      },
    });
    expect(result.upload?.expiresAt).toBe('2026-09-06T10:10:00.000Z');
  });

  it('creates message-image uploads in a separate server-owned folder', async () => {
    const { repository, storage, service } = createService();
    repository.createPending.mockImplementation(async (input) => ({
      status: 'created',
      asset: asset({
        id: input.id,
        purpose: input.purpose,
        cloudinaryPublicId: input.cloudinaryPublicId,
        uploadFingerprint: input.uploadFingerprint,
        originalFilename: input.originalFilename,
      }),
    }));
    storage.signImageUpload.mockResolvedValue({
      url: 'https://api.cloudinary.com/v1_1/demo/image/upload',
      method: 'POST',
      fields: {
        api_key: 'public-key',
        timestamp: '1788688800',
        signature: 'signature',
        public_id: 'public-id',
        context: 'context',
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'jpg,jpeg,png,webp',
        upload_preset: 'chateo_profile_avatars',
        transformation: 'c_limit,h_2048,w_2048/q_auto',
      },
    });

    const result = await service.createUpload(USER_ID, {
      clientUploadId: CLIENT_UPLOAD_ID,
      purpose: 'message_attachment',
      contentType: 'image/png',
      sizeBytes: 512000,
      originalFilename: 'chat-image.png',
    });

    const createInput = repository.createPending.mock.calls[0]?.[0];
    expect(createInput).toMatchObject({
      purpose: 'MESSAGE_ATTACHMENT',
      mimeType: 'image/png',
      originalFilename: 'chat-image.png',
    });
    expect(createInput?.cloudinaryPublicId).toMatch(
      /^chateo\/message-images\/[0-9a-f-]{36}$/,
    );
    expect(result.media).toMatchObject({
      purpose: 'message_attachment',
      status: 'pending',
      type: 'image',
    });
  });

  it('creates chat-audio uploads in a video resource folder without an image transformation', async () => {
    const { repository, storage, service } = createService();
    repository.createPending.mockImplementation(async (input) => ({
      status: 'created',
      asset: asset({
        id: input.id,
        purpose: input.purpose,
        cloudinaryPublicId: input.cloudinaryPublicId,
        uploadFingerprint: input.uploadFingerprint,
        resourceType: input.resourceType,
        mimeType: input.mimeType,
        byteSize: input.byteSize,
        originalFilename: input.originalFilename,
      }),
    }));
    storage.signAudioUpload.mockResolvedValue({
      url: 'https://api.cloudinary.com/v1_1/demo/video/upload',
      method: 'POST',
      fields: {
        api_key: 'public-key',
        timestamp: '1788688800',
        signature: 'signature',
        public_id: 'public-id',
        context: 'context',
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'aac,m4a,mp3,ogg,wav',
        upload_preset: 'chateo_chat_audio',
      },
    });

    const result = await service.createUpload(USER_ID, {
      clientUploadId: CLIENT_UPLOAD_ID,
      purpose: 'message_attachment',
      contentType: 'audio/mp4',
      sizeBytes: 7 * 1024 * 1024,
      originalFilename: 'voice-note.m4a',
    });

    const createInput = repository.createPending.mock.calls[0]?.[0];
    expect(createInput).toMatchObject({
      purpose: 'MESSAGE_ATTACHMENT',
      resourceType: 'video',
      mimeType: 'audio/mp4',
      originalFilename: 'voice-note.m4a',
    });
    expect(createInput?.cloudinaryPublicId).toMatch(
      /^chateo\/message-audio\/[0-9a-f-]{36}$/,
    );
    expect(storage.signAudioUpload).toHaveBeenCalledWith({
      publicId: createInput?.cloudinaryPublicId,
      timestamp: NOW,
      context: {
        media_id: createInput?.id,
        upload_fingerprint: createInput?.uploadFingerprint,
      },
    });
    expect(storage.signImageUpload).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      media: {
        purpose: 'message_attachment',
        status: 'pending',
        type: 'audio',
        contentType: 'audio/mp4',
        durationMs: null,
      },
      upload: {
        url: 'https://api.cloudinary.com/v1_1/demo/video/upload',
      },
    });
  });

  it('rejects profile audio before persistence even when called outside validation pipes', async () => {
    const { repository, storage, service } = createService();

    await expectApiError(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'profile_avatar',
        contentType: 'audio/mp4',
        sizeBytes: 1000,
      }),
      HttpStatus.BAD_REQUEST,
      'MEDIA_UPLOAD_CONTENT_TYPE_UNSUPPORTED',
    );
    expect(repository.createPending).not.toHaveBeenCalled();
    expect(storage.signAudioUpload).not.toHaveBeenCalled();
  });

  it('maps a reused client ID with different data to a stable conflict', async () => {
    const { repository, service } = createService();
    repository.createPending.mockResolvedValue({
      status: 'idempotency-conflict',
    });

    await expectApiError(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'profile_avatar',
        contentType: 'image/png',
        sizeBytes: 10,
      }),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT',
    );
  });

  it('replays an existing pending upload using its original identity and timestamp', async () => {
    const { repository, storage, service } = createService();
    const originalCreatedAt = new Date('2026-09-06T09:59:00.000Z');
    const existing = asset({ createdAt: originalCreatedAt });
    repository.createPending.mockResolvedValue({
      status: 'existing',
      asset: existing,
    });
    storage.signImageUpload.mockResolvedValue({
      url: 'https://api.cloudinary.com/v1_1/demo/image/upload',
      method: 'POST',
      fields: {
        api_key: 'public-key',
        timestamp: '1788688740',
        signature: 'signature',
        public_id: existing.cloudinaryPublicId,
        context: 'context',
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'jpg,jpeg,png,webp',
        upload_preset: 'chateo_profile_avatars',
        transformation: 'c_limit,h_2048,w_2048/q_auto',
      },
    });

    await expect(
      service.createUpload(USER_ID.toUpperCase(), {
        clientUploadId: CLIENT_UPLOAD_ID.toUpperCase(),
        purpose: 'profile_avatar',
        contentType: 'image/jpeg',
        sizeBytes: 245000,
        originalFilename: '  avatar.jpg  ',
      }),
    ).resolves.toMatchObject({
      media: { id: MEDIA_ID, status: 'pending' },
      upload: { fields: { public_id: existing.cloudinaryPublicId } },
    });
    expect(storage.signImageUpload).toHaveBeenCalledWith({
      publicId: existing.cloudinaryPublicId,
      timestamp: originalCreatedAt,
      context: {
        media_id: MEDIA_ID,
        upload_fingerprint: existing.uploadFingerprint,
      },
    });
    expect(repository.createPending).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: USER_ID,
        clientUploadId: CLIENT_UPLOAD_ID,
        originalFilename: 'avatar.jpg',
      }),
    );
  });

  it('returns an existing ready upload without issuing another authorization', async () => {
    const { repository, storage, service } = createService();
    repository.createPending.mockResolvedValue({
      status: 'existing',
      asset: asset({
        status: 'READY',
        format: 'jpg',
        width: 640,
        height: 480,
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
        completedAt: NOW,
      }),
    });

    await expect(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'profile_avatar',
        contentType: 'image/jpeg',
        sizeBytes: 245000,
      }),
    ).resolves.toMatchObject({
      media: { id: MEDIA_ID, status: 'ready' },
      upload: null,
    });
    expect(storage.signImageUpload).not.toHaveBeenCalled();
  });

  it('rejects expired and failed idempotency replays without signing them', async () => {
    for (const testCase of [
      {
        record: asset({ expiresAt: NOW }),
        status: HttpStatus.GONE,
        code: 'MEDIA_UPLOAD_EXPIRED',
      },
      {
        record: asset({ status: 'FAILED', failedAt: NOW }),
        status: HttpStatus.CONFLICT,
        code: 'MEDIA_UPLOAD_NOT_REUSABLE',
      },
    ]) {
      const { repository, storage, service } = createService();
      repository.createPending.mockResolvedValue({
        status: 'existing',
        asset: testCase.record,
      });

      await expectApiError(
        service.createUpload(USER_ID, {
          clientUploadId: CLIENT_UPLOAD_ID,
          purpose: 'profile_avatar',
          contentType: 'image/jpeg',
          sizeBytes: 245000,
        }),
        testCase.status,
        testCase.code,
      );
      expect(storage.signImageUpload).not.toHaveBeenCalled();
    }
  });

  it('enforces the configured upload limit before creating an asset', async () => {
    const { repository, service } = createService({
      MEDIA_MAX_PROFILE_AVATAR_BYTES: 1024,
    });

    await expectApiError(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'profile_avatar',
        contentType: 'image/jpeg',
        sizeBytes: 1025,
      }),
      HttpStatus.PAYLOAD_TOO_LARGE,
      'MEDIA_UPLOAD_TOO_LARGE',
    );
    expect(repository.createPending).not.toHaveBeenCalled();
  });

  it('enforces the configured audio limit before creating an asset', async () => {
    const { repository, service } = createService({
      MEDIA_MAX_CHAT_AUDIO_BYTES: 4096,
    });

    await expectApiError(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'message_attachment',
        contentType: 'audio/mpeg',
        sizeBytes: 4097,
      }),
      HttpStatus.PAYLOAD_TOO_LARGE,
      'MEDIA_UPLOAD_TOO_LARGE',
    );
    expect(repository.createPending).not.toHaveBeenCalled();
  });

  it('reports a missing chat-audio preset without disabling image uploads', async () => {
    const { repository, storage, service } = createService();
    repository.createPending.mockImplementation(async (input) => ({
      status: 'created',
      asset: asset({
        id: input.id,
        purpose: input.purpose,
        cloudinaryPublicId: input.cloudinaryPublicId,
        uploadFingerprint: input.uploadFingerprint,
        resourceType: input.resourceType,
        mimeType: input.mimeType,
      }),
    }));
    storage.signAudioUpload.mockRejectedValue(
      new MediaStorageError('audio-not-configured', 'missing audio preset'),
    );

    await expectApiError(
      service.createUpload(USER_ID, {
        clientUploadId: CLIENT_UPLOAD_ID,
        purpose: 'message_attachment',
        contentType: 'audio/mpeg',
        sizeBytes: 2048,
      }),
      HttpStatus.SERVICE_UNAVAILABLE,
      'MEDIA_AUDIO_UPLOADS_DISABLED',
    );
  });

  it.each([
    [
      new MediaStorageError('not-configured', 'disabled'),
      HttpStatus.SERVICE_UNAVAILABLE,
      'MEDIA_UPLOADS_DISABLED',
    ],
    [
      new MediaStorageError('invalid-response', 'bad response'),
      HttpStatus.BAD_GATEWAY,
      'MEDIA_STORAGE_UNAVAILABLE',
    ],
    [
      new Error('unexpected'),
      HttpStatus.BAD_GATEWAY,
      'MEDIA_STORAGE_UNAVAILABLE',
    ],
  ] as const)(
    'maps signing failure %# to a stable API error',
    async (failure, status, code) => {
      const { repository, storage, service } = createService();
      repository.createPending.mockResolvedValue({
        status: 'created',
        asset: asset(),
      });
      storage.signImageUpload.mockRejectedValue(failure);

      await expectApiError(
        service.createUpload(USER_ID, {
          clientUploadId: CLIENT_UPLOAD_ID,
          purpose: 'profile_avatar',
          contentType: 'image/jpeg',
          sizeBytes: 245000,
        }),
        status,
        code,
      );
    },
  );

  it('verifies Cloudinary metadata before atomically completing an upload', async () => {
    const { repository, storage, service } = createService();
    const pending = asset();
    const ready = asset({
      status: 'READY',
      format: 'jpg',
      width: 640,
      height: 640,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
      completedAt: NOW,
    });
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(resource(pending));
    repository.completePending.mockResolvedValue({
      status: 'ready',
      asset: ready,
    });

    await expect(
      service.completeUpload(USER_ID, MEDIA_ID),
    ).resolves.toMatchObject({
      id: MEDIA_ID,
      status: 'ready',
      width: 640,
      height: 640,
    });
    expect(repository.completePending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MEDIA_ID,
        ownerId: USER_ID,
        cloudinaryAssetId: 'cloudinary-asset-id',
        byteSize: 245000,
      }),
    );
  });

  it('completes an owned message attachment and preserves its purpose', async () => {
    const { repository, storage, service } = createService();
    const pending = asset({
      purpose: 'MESSAGE_ATTACHMENT',
      cloudinaryPublicId: `chateo/message-images/${MEDIA_ID}`,
      mimeType: 'image/webp',
      originalFilename: 'chat-image.webp',
    });
    const ready = asset({
      ...pending,
      status: 'READY',
      format: 'webp',
      byteSize: 120000,
      width: 800,
      height: 600,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/chat-image.webp',
      completedAt: NOW,
    });
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(
      resource(pending, {
        format: 'webp',
        byteSize: 120000,
        width: 800,
        height: 600,
        secureUrl:
          'https://res.cloudinary.com/demo/image/upload/chat-image.webp',
      }),
    );
    repository.completePending.mockResolvedValue({
      status: 'ready',
      asset: ready,
    });

    await expect(
      service.completeUpload(USER_ID, MEDIA_ID),
    ).resolves.toMatchObject({
      id: MEDIA_ID,
      purpose: 'message_attachment',
      status: 'ready',
      contentType: 'image/webp',
      sizeBytes: 120000,
    });
  });

  it.each([
    ['audio/aac', 'aac'],
    ['audio/mp4', 'm4a'],
    ['audio/m4a', 'm4a'],
    ['audio/x-m4a', 'm4a'],
    ['audio/mpeg', 'mp3'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
  ] as const)(
    'completes %s audio when Cloudinary reports %s',
    async (mimeType, format) => {
      const { repository, storage, service } = createService();
      const pending = asset({
        purpose: 'MESSAGE_ATTACHMENT',
        cloudinaryPublicId: `chateo/message-audio/${MEDIA_ID}`,
        resourceType: 'video',
        mimeType,
        byteSize: 800000,
        originalFilename: `voice-note.${format}`,
      });
      const ready = asset({
        ...pending,
        status: 'READY',
        format,
        width: null,
        height: null,
        durationMs: 12345,
        secureUrl: `https://res.cloudinary.com/demo/video/upload/voice-note.${format}`,
        completedAt: NOW,
      });
      repository.findForOwner.mockResolvedValue(pending);
      storage.findAudio.mockResolvedValue(
        audioResource(pending, {
          format,
          durationSeconds: 12.345,
          secureUrl: ready.secureUrl!,
        }),
      );
      repository.completePending.mockResolvedValue({
        status: 'ready',
        asset: ready,
      });

      await expect(
        service.completeUpload(USER_ID, MEDIA_ID),
      ).resolves.toMatchObject({
        id: MEDIA_ID,
        purpose: 'message_attachment',
        status: 'ready',
        type: 'audio',
        contentType: mimeType,
        width: null,
        height: null,
        durationMs: 12345,
      });
      expect(storage.findAudio).toHaveBeenCalledWith(
        `chateo/message-audio/${MEDIA_ID}`,
      );
      expect(storage.findImage).not.toHaveBeenCalled();
      expect(repository.completePending).toHaveBeenCalledWith({
        id: MEDIA_ID,
        ownerId: USER_ID,
        cloudinaryAssetId: 'cloudinary-audio-asset-id',
        format,
        byteSize: 800000,
        width: null,
        height: null,
        durationMs: 12345,
        secureUrl: ready.secureUrl,
        etag: 'audio-etag',
        now: NOW,
      });
    },
  );

  it.each([
    ['mismatched format', { format: 'mp3' }],
    ['wrong resource type', { resourceType: 'image' }],
    ['wrong delivery type', { deliveryType: 'authenticated' }],
    ['oversized provider object', { byteSize: 20 * 1024 * 1024 + 1 }],
    ['overlong duration', { durationSeconds: 900.001 }],
    ['zero duration', { durationSeconds: 0 }],
    ['wrong ownership context', { context: { media_id: 'wrong' } }],
    ['insecure delivery URL', { secureUrl: 'http://example.com/audio.m4a' }],
  ] as const)('rejects audio with %s', async (_label, resourceOverrides) => {
    const { repository, storage, service } = createService();
    const pending = asset({
      purpose: 'MESSAGE_ATTACHMENT',
      cloudinaryPublicId: `chateo/message-audio/${MEDIA_ID}`,
      resourceType: 'video',
      mimeType: 'audio/mp4',
      byteSize: 800000,
    });
    repository.findForOwner.mockResolvedValue(pending);
    storage.findAudio.mockResolvedValue(
      audioResource(pending, resourceOverrides),
    );

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_VERIFICATION_FAILED',
    );
    expect(repository.failPending).toHaveBeenCalledWith(MEDIA_ID, USER_ID, NOW);
    expect(repository.completePending).not.toHaveBeenCalled();
  });

  it('rejects and marks mismatched or oversized Cloudinary resources', async () => {
    const { repository, storage, service } = createService();
    const pending = asset();
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(
      resource(pending, { width: 9000, height: 9000 }),
    );

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_VERIFICATION_FAILED',
    );
    expect(repository.failPending).toHaveBeenCalledWith(MEDIA_ID, USER_ID, NOW);
    expect(storage.deleteImage).not.toHaveBeenCalled();
  });

  it('does not delete rejected media synchronously from the request path', async () => {
    const { repository, storage, service } = createService();
    const pending = asset();
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(
      resource(pending, { context: { media_id: 'wrong-id' } }),
    );

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_VERIFICATION_FAILED',
    );
    expect(repository.failPending).toHaveBeenCalledWith(MEDIA_ID, USER_ID, NOW);
    expect(storage.deleteImage).not.toHaveBeenCalled();
  });

  it('does not reject an upload when Cloudinary has a transient failure', async () => {
    const { repository, storage, service } = createService();
    repository.findForOwner.mockResolvedValue(asset());
    storage.findImage.mockRejectedValue(
      new MediaStorageError('unavailable', 'temporary failure'),
    );

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.BAD_GATEWAY,
      'MEDIA_STORAGE_UNAVAILABLE',
    );
    expect(repository.failPending).not.toHaveBeenCalled();
    expect(storage.deleteImage).not.toHaveBeenCalled();
  });

  it('returns not-ready without mutating a pending upload Cloudinary cannot find', async () => {
    const { repository, storage, service } = createService();
    repository.findForOwner.mockResolvedValue(asset());
    storage.findImage.mockResolvedValue(null);

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_NOT_READY',
    );
    expect(repository.completePending).not.toHaveBeenCalled();
    expect(repository.failPending).not.toHaveBeenCalled();
    expect(storage.deleteImage).not.toHaveBeenCalled();
  });

  it('hides missing and foreign uploads behind the same owner-scoped 404', async () => {
    const { repository, storage, service } = createService();
    repository.findForOwner.mockResolvedValue(null);

    await expectApiError(
      service.completeUpload(USER_ID.toUpperCase(), MEDIA_ID.toUpperCase()),
      HttpStatus.NOT_FOUND,
      'MEDIA_UPLOAD_NOT_FOUND',
    );
    expect(repository.findForOwner).toHaveBeenCalledWith(MEDIA_ID, USER_ID);
    expect(storage.findImage).not.toHaveBeenCalled();
  });

  it('rejects and marks an upload whose authorization expired', async () => {
    const { repository, storage, service } = createService();
    const expired = asset({ expiresAt: NOW });
    repository.findForOwner.mockResolvedValue(expired);

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.GONE,
      'MEDIA_UPLOAD_EXPIRED',
    );
    expect(repository.failPending).toHaveBeenCalledWith(MEDIA_ID, USER_ID, NOW);
    expect(storage.deleteImage).not.toHaveBeenCalled();
    expect(storage.findImage).not.toHaveBeenCalled();
  });

  it('replays a completed upload without asking Cloudinary again', async () => {
    const { repository, storage, service } = createService();
    repository.findForOwner.mockResolvedValue(
      asset({
        status: 'READY',
        format: 'webp',
        mimeType: 'image/webp',
        width: 320,
        height: 240,
        secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.webp',
        completedAt: NOW,
      }),
    );

    await expect(
      service.completeUpload(USER_ID, MEDIA_ID),
    ).resolves.toMatchObject({ id: MEDIA_ID, status: 'ready' });
    expect(storage.findImage).not.toHaveBeenCalled();
    expect(repository.completePending).not.toHaveBeenCalled();
  });

  it('converges on the ready record when another completion wins the race', async () => {
    const { repository, storage, service } = createService();
    const pending = asset();
    const ready = asset({
      status: 'READY',
      format: 'jpg',
      width: 640,
      height: 640,
      secureUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
      completedAt: NOW,
    });
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(resource(pending));
    repository.completePending.mockResolvedValue({
      status: 'not-pending',
      asset: ready,
    });

    await expect(
      service.completeUpload(USER_ID, MEDIA_ID),
    ).resolves.toMatchObject({ id: MEDIA_ID, status: 'ready' });
  });

  it('returns gone when the atomic completion detects an expiry race', async () => {
    const { repository, storage, service } = createService();
    const pending = asset();
    const expired = asset({ expiresAt: NOW });
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(resource(pending));
    repository.completePending.mockResolvedValue({
      status: 'expired',
      asset: expired,
    });

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.GONE,
      'MEDIA_UPLOAD_EXPIRED',
    );
    expect(repository.failPending).toHaveBeenCalledWith(MEDIA_ID, USER_ID, NOW);
  });

  it('rejects non-positive dimensions even if a provider returns them', async () => {
    const { repository, storage, service } = createService();
    const pending = asset();
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(
      resource(pending, { width: -1, height: -1 }),
    );

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_VERIFICATION_FAILED',
    );
    expect(repository.completePending).not.toHaveBeenCalled();
  });

  it('rejects non-integer dimensions even if a provider returns them', async () => {
    const { repository, storage, service } = createService();
    const pending = asset({ purpose: 'MESSAGE_ATTACHMENT' });
    repository.findForOwner.mockResolvedValue(pending);
    storage.findImage.mockResolvedValue(
      resource(pending, { width: 640.5, height: 480 }),
    );

    await expectApiError(
      service.completeUpload(USER_ID, MEDIA_ID),
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_VERIFICATION_FAILED',
    );
    expect(repository.completePending).not.toHaveBeenCalled();
  });

  it('sets only a ready owned media asset as the profile avatar', async () => {
    const { repository, service } = createService();
    repository.setProfileAvatar.mockResolvedValue({
      status: 'updated',
      user: {
        id: USER_ID,
        phoneNumber: '+2348012345678',
        displayName: 'Ada',
        avatarUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
        profileCompletedAt: NOW,
        createdAt: NOW,
      },
    });

    await expect(service.setProfileAvatar(USER_ID, MEDIA_ID)).resolves.toEqual({
      id: USER_ID,
      phoneNumber: '+2348012345678',
      displayName: 'Ada',
      avatarUrl: 'https://res.cloudinary.com/demo/image/upload/avatar.jpg',
      profileComplete: true,
      createdAt: NOW.toISOString(),
    });
  });

  it.each([
    ['media-not-found', HttpStatus.NOT_FOUND, 'MEDIA_UPLOAD_NOT_FOUND'],
    ['media-not-ready', HttpStatus.CONFLICT, 'PROFILE_AVATAR_NOT_READY'],
  ] as const)(
    'maps avatar repository status %s to a stable error',
    async (repositoryStatus, status, code) => {
      const { repository, service } = createService();
      repository.setProfileAvatar.mockResolvedValue({
        status: repositoryStatus,
      });

      await expectApiError(
        service.setProfileAvatar(USER_ID.toUpperCase(), MEDIA_ID.toUpperCase()),
        status,
        code,
      );
      expect(repository.setProfileAvatar).toHaveBeenCalledWith(
        USER_ID,
        MEDIA_ID,
      );
    },
  );

  it('clears an avatar idempotently and reports a missing signed-in user', async () => {
    const first = createService();
    first.repository.clearProfileAvatar.mockResolvedValue({
      id: USER_ID,
      phoneNumber: '+2348012345678',
      displayName: 'Ada',
      avatarUrl: null,
      profileCompletedAt: NOW,
      createdAt: NOW,
    });

    await expect(
      first.service.clearProfileAvatar(USER_ID.toUpperCase()),
    ).resolves.toBeUndefined();
    expect(first.repository.clearProfileAvatar).toHaveBeenCalledWith(USER_ID);

    const missing = createService();
    missing.repository.clearProfileAvatar.mockResolvedValue(null);
    await expectApiError(
      missing.service.clearProfileAvatar(USER_ID),
      HttpStatus.NOT_FOUND,
      'USER_NOT_FOUND',
    );
  });
});

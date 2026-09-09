import { ConfigService } from '@nestjs/config';
import { CloudinaryMediaProvider } from './cloudinary-media.provider';
import { MediaStorageError } from './media-storage.provider';

const API_SECRET = 'cloudinary-secret-at-least-16';

function createProvider(
  overrides: Record<string, unknown> = {},
): CloudinaryMediaProvider {
  const values: Record<string, unknown> = {
    MEDIA_UPLOADS_ENABLED: true,
    CLOUDINARY_CLOUD_NAME: 'demo',
    CLOUDINARY_API_KEY: 'public-api-key',
    CLOUDINARY_API_SECRET: API_SECRET,
    CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: 'chateo_profile_avatars',
    CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET: 'chateo_chat_audio',
    ...overrides,
  };
  const config = {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      key in values ? values[key] : defaultValue,
    ),
    getOrThrow: jest.fn((key: string) => {
      if (!(key in values)) throw new Error(`Missing ${key}`);
      return values[key];
    }),
  } as unknown as ConfigService;
  return new CloudinaryMediaProvider(config);
}

async function expectStorageError(
  promise: Promise<unknown>,
  reason: MediaStorageError['reason'],
): Promise<void> {
  const error = await promise.then(
    () => new Error(`Expected ${reason}, but the operation resolved.`),
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(MediaStorageError);
  expect((error as MediaStorageError).reason).toBe(reason);
}

describe('CloudinaryMediaProvider', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns exact multipart fields signed with deterministic SHA-256', async () => {
    const provider = createProvider();

    const result = await provider.signImageUpload({
      publicId: 'chateo/profile-avatars/22222222-2222-4222-8222-222222222222',
      timestamp: new Date('2026-09-06T10:00:00.000Z'),
      context: {
        upload_fingerprint: 'f'.repeat(64),
        media_id: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(result).toEqual({
      url: 'https://api.cloudinary.com/v1_1/demo/image/upload',
      method: 'POST',
      fields: {
        api_key: 'public-api-key',
        timestamp: '1788688800',
        signature:
          '27006323bdf1b8f53fbfa9570cce9c1d114ee52ce33a390eae7753c782210730',
        public_id:
          'chateo/profile-avatars/22222222-2222-4222-8222-222222222222',
        context: `media_id=22222222-2222-4222-8222-222222222222|upload_fingerprint=${'f'.repeat(64)}`,
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'jpg,jpeg,png,webp',
        upload_preset: 'chateo_profile_avatars',
        transformation: 'c_limit,h_2048,w_2048/q_auto',
      },
    });
    expect(JSON.stringify(result)).not.toContain(API_SECRET);
  });

  it('signs audio-only formats against the Cloudinary video upload endpoint', async () => {
    const provider = createProvider();

    const result = await provider.signAudioUpload({
      publicId: 'chateo/message-audio/22222222-2222-4222-8222-222222222222',
      timestamp: new Date('2026-09-06T10:00:00.000Z'),
      context: {
        upload_fingerprint: 'f'.repeat(64),
        media_id: '22222222-2222-4222-8222-222222222222',
      },
    });

    expect(result).toEqual({
      url: 'https://api.cloudinary.com/v1_1/demo/video/upload',
      method: 'POST',
      fields: {
        api_key: 'public-api-key',
        timestamp: '1788688800',
        signature:
          '21bd86903ecf241c7498c4a2bacf960407387dcba431364ae101b07dda33d69a',
        public_id: 'chateo/message-audio/22222222-2222-4222-8222-222222222222',
        context: `media_id=22222222-2222-4222-8222-222222222222|upload_fingerprint=${'f'.repeat(64)}`,
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'aac,m4a,mp3,ogg,wav',
        upload_preset: 'chateo_chat_audio',
      },
    });
    expect(JSON.stringify(result)).not.toContain(API_SECRET);
    expect(JSON.stringify(result)).not.toContain('transformation');
  });

  it('requires the audio preset only when signing an audio upload', async () => {
    const provider = createProvider({
      CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET: '',
    });

    await expect(
      provider.signImageUpload({
        publicId: 'chateo/profile-avatars/media-id',
        timestamp: new Date('2026-09-06T10:00:00.000Z'),
        context: {},
      }),
    ).resolves.toMatchObject({
      url: 'https://api.cloudinary.com/v1_1/demo/image/upload',
    });
    await expectStorageError(
      provider.signAudioUpload({
        publicId: 'chateo/message-audio/media-id',
        timestamp: new Date('2026-09-06T10:00:00.000Z'),
        context: {},
      }),
      'audio-not-configured',
    );
  });

  it('requests contextual metadata and parses a verified image resource', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          asset_id: 'asset-id',
          public_id: 'chateo/profile-avatars/media-id',
          resource_type: 'image',
          type: 'upload',
          format: 'JPG',
          bytes: 123,
          width: 640,
          height: 480,
          secure_url: 'https://res.cloudinary.com/demo/image/upload/image.jpg',
          etag: 'etag',
          context: { custom: { media_id: 'media-id' } },
        }),
        { status: 200 },
      ),
    );
    const provider = createProvider();

    await expect(
      provider.findImage('chateo/profile-avatars/media-id'),
    ).resolves.toMatchObject({
      assetId: 'asset-id',
      format: 'jpg',
      context: { media_id: 'media-id' },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://api.cloudinary.com/v1_1/demo/resources/image/upload/chateo%2Fprofile-avatars%2Fmedia-id?context=true&media_metadata=true',
    );
    expect(fetchSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        headers: {
          authorization: `Basic ${Buffer.from(`public-api-key:${API_SECRET}`, 'utf8').toString('base64')}`,
        },
      }),
    );
    expect(String(fetchSpy.mock.calls[0]?.[0])).not.toContain(API_SECRET);
  });

  it('requests and parses audio metadata through the video resource endpoint', async () => {
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          asset_id: 'audio-asset-id',
          public_id: 'chateo/message-audio/media-id',
          resource_type: 'video',
          type: 'upload',
          format: 'M4A',
          bytes: 123456,
          duration: 12.345,
          secure_url:
            'https://res.cloudinary.com/demo/video/upload/voice-note.m4a',
          etag: 'audio-etag',
          context: { custom: { media_id: 'media-id' } },
        }),
        { status: 200 },
      ),
    );

    await expect(
      createProvider().findAudio('chateo/message-audio/media-id'),
    ).resolves.toEqual({
      assetId: 'audio-asset-id',
      publicId: 'chateo/message-audio/media-id',
      resourceType: 'video',
      deliveryType: 'upload',
      format: 'm4a',
      byteSize: 123456,
      durationSeconds: 12.345,
      secureUrl: 'https://res.cloudinary.com/demo/video/upload/voice-note.m4a',
      etag: 'audio-etag',
      context: { media_id: 'media-id' },
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://api.cloudinary.com/v1_1/demo/resources/video/upload/chateo%2Fmessage-audio%2Fmedia-id?context=true&media_metadata=true',
    );
  });

  it.each([undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid audio duration metadata %#',
    async (duration) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            asset_id: 'audio-asset-id',
            public_id: 'chateo/message-audio/media-id',
            resource_type: 'video',
            type: 'upload',
            format: 'mp3',
            bytes: 123,
            duration,
            secure_url:
              'https://res.cloudinary.com/demo/video/upload/audio.mp3',
          }),
          { status: 200 },
        ),
      );

      await expectStorageError(
        createProvider().findAudio('chateo/message-audio/media-id'),
        'invalid-response',
      );
    },
  );

  it('treats Cloudinary 404 as an upload that has not arrived yet', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      createProvider().findImage('chateo/profile-avatars/media-id'),
    ).resolves.toBeNull();
  });

  it.each([
    [
      'an upstream error',
      () => new Response('unavailable', { status: 503 }),
      'unavailable',
    ],
    [
      'invalid JSON',
      () => new Response('{', { status: 200 }),
      'invalid-response',
    ],
    [
      'incomplete metadata',
      () =>
        new Response(
          JSON.stringify({
            asset_id: 'asset-id',
            public_id: 'public-id',
            resource_type: 'image',
            type: 'upload',
            format: 'jpg',
            bytes: 1,
            width: 1,
            height: 1,
            secure_url: 'http://res.cloudinary.com/insecure.jpg',
          }),
          { status: 200 },
        ),
      'invalid-response',
    ],
  ] as const)(
    'maps %s to a stable storage error',
    async (_label, responseFactory, reason) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(responseFactory());

      await expectStorageError(
        createProvider().findImage('chateo/profile-avatars/media-id'),
        reason,
      );
    },
  );

  it('wraps a network failure without exposing provider details', async () => {
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('socket failure'));

    await expectStorageError(
      createProvider().findImage('chateo/profile-avatars/media-id'),
      'unavailable',
    );
  });

  it.each([
    'sign-image',
    'sign-audio',
    'find-image',
    'find-audio',
    'delete-image',
    'delete-audio',
  ] as const)(
    'rejects %s operations when media uploads are disabled',
    async (operation) => {
      const provider = createProvider({ MEDIA_UPLOADS_ENABLED: false });
      const promise =
        operation === 'sign-image'
          ? provider.signImageUpload({
              publicId: 'public-id',
              timestamp: new Date('2026-09-06T10:00:00.000Z'),
              context: {},
            })
          : operation === 'sign-audio'
            ? provider.signAudioUpload({
                publicId: 'public-id',
                timestamp: new Date('2026-09-06T10:00:00.000Z'),
                context: {},
              })
            : operation === 'find-image'
              ? provider.findImage('public-id')
              : operation === 'find-audio'
                ? provider.findAudio('public-id')
                : operation === 'delete-image'
                  ? provider.deleteImage('public-id')
                  : provider.deleteAudio('public-id');

      await expectStorageError(promise, 'not-configured');
      expect(global.fetch).toBeDefined();
    },
  );

  it('signs a server-side destroy request without sending the secret', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-09-06T10:00:00.000Z').getTime());
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ result: 'ok' })));

    await createProvider().deleteImage(
      'chateo/profile-avatars/22222222-2222-4222-8222-222222222222',
    );

    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(url).toBe('https://api.cloudinary.com/v1_1/demo/image/destroy');
    expect(init).toEqual(
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
      }),
    );
    const body = String(init?.body);
    expect(body).toContain('api_key=public-api-key');
    expect(body).not.toContain('overwrite');
    expect(body).toContain('invalidate=true');
    expect(body).toContain('timestamp=1788688800');
    expect(body).toContain('signature=');
    expect(body).not.toContain(API_SECRET);
  });

  it('uses the video destroy endpoint for audio cleanup', async () => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-09-06T10:00:00.000Z').getTime());
    const fetchSpy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ result: 'ok' })));

    await createProvider().deleteAudio('chateo/message-audio/media-id');

    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      'https://api.cloudinary.com/v1_1/demo/video/destroy',
    );
  });

  it.each([
    ['network rejection', () => Promise.reject(new Error('offline'))],
    [
      'non-success response',
      () => Promise.resolve(new Response('bad gateway', { status: 502 })),
    ],
  ] as const)('maps delete %s to unavailable', async (_label, response) => {
    jest.spyOn(global, 'fetch').mockImplementation(response);

    await expectStorageError(
      createProvider().deleteImage('chateo/profile-avatars/media-id'),
      'unavailable',
    );
  });
});

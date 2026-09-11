import { validateEnvironment } from './environment';

const sharedConfig = {
  DATABASE_URL: 'postgresql://chateo:chateo@localhost:5432/chateo',
  JWT_ACCESS_SECRET: 'jwt-access-secret-that-is-at-least-32-characters',
  OTP_HASH_SECRET: 'otp-hash-secret-that-is-at-least-32-characters',
};

const twilioConfig = {
  OTP_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`,
  TWILIO_API_KEY: `SK${'b'.repeat(32)}`,
  TWILIO_API_SECRET: 'twilio-api-secret-at-least-16-characters',
  TWILIO_FROM_NUMBER: '+15551234567',
};

describe('validateEnvironment', () => {
  it('keeps unused cleanup and push opt-in and validates their operational limits', () => {
    const input = { ...sharedConfig, NODE_ENV: 'test' };
    expect(validateEnvironment(input)).toMatchObject({
      PUSH_NOTIFICATIONS_ENABLED: false,
      MEDIA_UNUSED_CLEANUP_ENABLED: false,
      MEDIA_UNUSED_RETENTION_HOURS: 24,
      PUSH_OFFLINE_DELAY_SECONDS: 15,
    });
    expect(() =>
      validateEnvironment({ ...input, PUSH_NOTIFICATIONS_ENABLED: true }),
    ).toThrow('EXPO_ACCESS_TOKEN');
    expect(() =>
      validateEnvironment({ ...input, MEDIA_UNUSED_RETENTION_HOURS: 23 }),
    ).toThrow('MEDIA_UNUSED_RETENTION_HOURS');
    expect(() =>
      validateEnvironment({ ...input, PUSH_OFFLINE_DELAY_SECONDS: 0 }),
    ).toThrow('PUSH_OFFLINE_DELAY_SECONDS');
    expect(
      validateEnvironment({
        ...input,
        PUSH_NOTIFICATIONS_ENABLED: true,
        EXPO_ACCESS_TOKEN: 'server-only-test-token',
      }),
    ).toMatchObject({ PUSH_NOTIFICATIONS_ENABLED: true });
  });
  it.each(['development', 'test'] as const)(
    'accepts the console provider in %s',
    (nodeEnvironment) => {
      const environment = validateEnvironment({
        ...sharedConfig,
        NODE_ENV: nodeEnvironment,
        OTP_PROVIDER: 'console',
        AUTH_OTP_LENGTH: 4,
        AUTH_FIXED_OTP: '1234',
      });

      expect(environment).toMatchObject({
        NODE_ENV: nodeEnvironment,
        OTP_PROVIDER: 'console',
        AUTH_OTP_LENGTH: 4,
        AUTH_FIXED_OTP: '1234',
        API_DOCS_ENABLED: true,
        REALTIME_MAX_CONNECTIONS_PER_USER: 5,
      });
    },
  );

  it('rejects the console provider in production', () => {
    expect(() =>
      validateEnvironment({
        ...sharedConfig,
        NODE_ENV: 'production',
        OTP_PROVIDER: 'console',
        AUTH_OTP_LENGTH: 6,
      }),
    ).toThrow('OTP_PROVIDER=console is not allowed in production');
  });

  it('rejects a fixed OTP in production', () => {
    expect(() =>
      validateEnvironment({
        ...sharedConfig,
        ...twilioConfig,
        NODE_ENV: 'production',
        AUTH_OTP_LENGTH: 6,
        AUTH_FIXED_OTP: '123456',
      }),
    ).toThrow('AUTH_FIXED_OTP must be empty in production');
  });

  it('rejects a four-digit OTP in production', () => {
    expect(() =>
      validateEnvironment({
        ...sharedConfig,
        ...twilioConfig,
        NODE_ENV: 'production',
        AUTH_OTP_LENGTH: 4,
      }),
    ).toThrow('AUTH_OTP_LENGTH must be at least 6 in production');
  });

  it('accepts a valid six-digit Twilio production configuration', () => {
    const environment = validateEnvironment({
      ...sharedConfig,
      ...twilioConfig,
      NODE_ENV: 'production',
      AUTH_OTP_LENGTH: 6,
    });

    expect(environment).toMatchObject({
      NODE_ENV: 'production',
      AUTH_OTP_LENGTH: 6,
      AUTH_FIXED_OTP: '',
      ...twilioConfig,
    });
  });

  it('allows deployed API documentation to be disabled explicitly', () => {
    const environment = validateEnvironment({
      ...sharedConfig,
      NODE_ENV: 'test',
      API_DOCS_ENABLED: 'false',
    });

    expect(environment.API_DOCS_ENABLED).toBe(false);
  });

  it('keeps media uploads disabled by default', () => {
    const environment = validateEnvironment({
      ...sharedConfig,
      NODE_ENV: 'test',
    });

    expect(environment).toMatchObject({
      MEDIA_UPLOADS_ENABLED: false,
      CLOUDINARY_UPLOAD_FOLDER: 'chateo',
      MEDIA_UPLOAD_TTL_SECONDS: 600,
      MEDIA_MAX_PROFILE_AVATAR_BYTES: 5242880,
      MEDIA_MAX_PROFILE_AVATAR_DIMENSION: 2048,
      MEDIA_MAX_PROFILE_AVATAR_PIXELS: 4194304,
      MEDIA_MAX_CHAT_AUDIO_BYTES: 20971520,
      MEDIA_MAX_CHAT_AUDIO_DURATION_MS: 900000,
      MEDIA_MAX_CHAT_VIDEO_BYTES: 52428800,
      MEDIA_MAX_CHAT_VIDEO_DURATION_MS: 300000,
      MEDIA_MAX_CHAT_DOCUMENT_BYTES: 26214400,
    });
  });

  it('accepts a complete Cloudinary configuration', () => {
    const environment = validateEnvironment({
      ...sharedConfig,
      NODE_ENV: 'test',
      MEDIA_UPLOADS_ENABLED: 'true',
      CLOUDINARY_CLOUD_NAME: 'chateo-demo',
      CLOUDINARY_API_KEY: '1234567890',
      CLOUDINARY_API_SECRET: 'cloudinary-secret-at-least-16',
      CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: 'chateo_profile_avatars',
      CLOUDINARY_UPLOAD_FOLDER: 'chateo/test',
    });

    expect(environment).toMatchObject({
      MEDIA_UPLOADS_ENABLED: true,
      CLOUDINARY_CLOUD_NAME: 'chateo-demo',
      CLOUDINARY_UPLOAD_FOLDER: 'chateo/test',
    });
  });

  it.each([
    ['MEDIA_MAX_CHAT_VIDEO_BYTES', 52428801],
    ['MEDIA_MAX_CHAT_VIDEO_DURATION_MS', 300001],
    ['MEDIA_MAX_CHAT_DOCUMENT_BYTES', 26214401],
    ['CLOUDINARY_CHAT_VIDEO_UPLOAD_PRESET', '../unsafe'],
    ['CLOUDINARY_CHAT_DOCUMENT_UPLOAD_PRESET', 'unsafe/preset'],
  ])('rejects invalid %s limits or preset names', (key, value) => {
    expect(() =>
      validateEnvironment({ ...sharedConfig, NODE_ENV: 'test', [key]: value }),
    ).toThrow(key);
  });

  it('accepts image-only uploads without an audio preset', () => {
    const environment = validateEnvironment({
      ...sharedConfig,
      NODE_ENV: 'test',
      MEDIA_UPLOADS_ENABLED: true,
      CLOUDINARY_CLOUD_NAME: 'chateo-demo',
      CLOUDINARY_API_KEY: '1234567890',
      CLOUDINARY_API_SECRET: 'cloudinary-secret-at-least-16',
      CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: 'chateo_profile_avatars',
    });

    expect(environment.CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET).toBeUndefined();
  });

  it('accepts a separate signed chat-audio preset', () => {
    const environment = validateEnvironment({
      ...sharedConfig,
      NODE_ENV: 'test',
      MEDIA_UPLOADS_ENABLED: true,
      CLOUDINARY_CLOUD_NAME: 'chateo-demo',
      CLOUDINARY_API_KEY: '1234567890',
      CLOUDINARY_API_SECRET: 'cloudinary-secret-at-least-16',
      CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: 'chateo_profile_avatars',
      CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET: 'chateo_chat_audio',
    });

    expect(environment.CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET).toBe(
      'chateo_chat_audio',
    );
  });

  it('rejects an unsafe chat-audio preset name when supplied', () => {
    expect(() =>
      validateEnvironment({
        ...sharedConfig,
        NODE_ENV: 'test',
        MEDIA_UPLOADS_ENABLED: true,
        CLOUDINARY_CLOUD_NAME: 'chateo-demo',
        CLOUDINARY_API_KEY: '1234567890',
        CLOUDINARY_API_SECRET: 'cloudinary-secret-at-least-16',
        CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: 'chateo_profile_avatars',
        CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET: 'chat/audio',
      }),
    ).toThrow('CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET');
  });

  it.each([
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET',
  ] as const)('rejects enabled media uploads without %s', (missingKey) => {
    const cloudinaryConfig: Record<string, unknown> = {
      ...sharedConfig,
      NODE_ENV: 'test',
      MEDIA_UPLOADS_ENABLED: true,
      CLOUDINARY_CLOUD_NAME: 'chateo-demo',
      CLOUDINARY_API_KEY: '1234567890',
      CLOUDINARY_API_SECRET: 'cloudinary-secret-at-least-16',
      CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: 'chateo_profile_avatars',
    };
    delete cloudinaryConfig[missingKey];

    expect(() => validateEnvironment(cloudinaryConfig)).toThrow(missingKey);
  });

  it.each([
    'TWILIO_ACCOUNT_SID',
    'TWILIO_API_KEY',
    'TWILIO_API_SECRET',
    'TWILIO_FROM_NUMBER',
  ] as const)('rejects Twilio configuration without %s', (missingKey) => {
    const incompleteTwilioConfig: Record<string, unknown> = {
      ...sharedConfig,
      ...twilioConfig,
      NODE_ENV: 'production',
      AUTH_OTP_LENGTH: 6,
    };
    delete incompleteTwilioConfig[missingKey];

    expect(() => validateEnvironment(incompleteTwilioConfig)).toThrow(
      missingKey,
    );
  });
});

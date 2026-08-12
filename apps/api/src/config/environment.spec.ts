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

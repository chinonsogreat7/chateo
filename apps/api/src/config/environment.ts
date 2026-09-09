import Joi from 'joi';

const environmentSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  OTP_HASH_SECRET: Joi.string().min(32).required(),
  OTP_PROVIDER: Joi.string().valid('console', 'twilio').default('console'),
  TWILIO_ACCOUNT_SID: Joi.when('OTP_PROVIDER', {
    is: 'twilio',
    then: Joi.string()
      .pattern(/^AC[0-9a-fA-F]{32}$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_API_KEY: Joi.when('OTP_PROVIDER', {
    is: 'twilio',
    then: Joi.string()
      .pattern(/^SK[0-9a-fA-F]{32}$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_API_SECRET: Joi.when('OTP_PROVIDER', {
    is: 'twilio',
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  TWILIO_FROM_NUMBER: Joi.when('OTP_PROVIDER', {
    is: 'twilio',
    then: Joi.string()
      .pattern(/^\+[1-9][0-9]{7,14}$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  AUTH_OTP_LENGTH: Joi.number().integer().min(4).max(8).default(4),
  AUTH_FIXED_OTP: Joi.string()
    .allow('')
    .pattern(/^\d{4,8}$/)
    .default(''),
  AUTH_OTP_TTL_SECONDS: Joi.number().integer().min(60).max(900).default(300),
  AUTH_OTP_RESEND_SECONDS: Joi.number().integer().min(15).max(300).default(24),
  AUTH_OTP_MAX_ATTEMPTS: Joi.number().integer().min(3).max(10).default(5),
  AUTH_OTP_LOCK_SECONDS: Joi.number().integer().min(60).max(86400).default(900),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3600)
    .default(900),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: Joi.number()
    .integer()
    .min(86400)
    .max(7776000)
    .default(2592000),
  API_DOCS_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  REALTIME_MAX_CONNECTIONS_PER_USER: Joi.number()
    .integer()
    .min(1)
    .max(20)
    .default(5),
  MEDIA_UPLOADS_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  CLOUDINARY_CLOUD_NAME: Joi.when('MEDIA_UPLOADS_ENABLED', {
    is: true,
    then: Joi.string()
      .trim()
      .pattern(/^[A-Za-z0-9_-]+$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  CLOUDINARY_API_KEY: Joi.when('MEDIA_UPLOADS_ENABLED', {
    is: true,
    then: Joi.string().trim().min(1).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  CLOUDINARY_API_SECRET: Joi.when('MEDIA_UPLOADS_ENABLED', {
    is: true,
    then: Joi.string().min(16).required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET: Joi.when('MEDIA_UPLOADS_ENABLED', {
    is: true,
    then: Joi.string()
      .trim()
      .max(255)
      .pattern(/^[A-Za-z0-9_-]+$/)
      .required(),
    otherwise: Joi.string().allow('').optional(),
  }),
  CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET: Joi.string()
    .trim()
    .max(255)
    .pattern(/^[A-Za-z0-9_-]+$/)
    .allow('')
    .optional(),
  CLOUDINARY_UPLOAD_FOLDER: Joi.string()
    .trim()
    .max(180)
    .pattern(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
    .default('chateo'),
  MEDIA_UPLOAD_TTL_SECONDS: Joi.number()
    .integer()
    .min(60)
    .max(3600)
    .default(600),
  MEDIA_MAX_PROFILE_AVATAR_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(5242880)
    .default(5242880),
  MEDIA_MAX_PROFILE_AVATAR_DIMENSION: Joi.number()
    .integer()
    .min(256)
    .max(4096)
    .default(2048),
  MEDIA_MAX_PROFILE_AVATAR_PIXELS: Joi.number()
    .integer()
    .min(65536)
    .max(16777216)
    .default(4194304),
  MEDIA_MAX_CHAT_AUDIO_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(20971520)
    .default(20971520),
  MEDIA_MAX_CHAT_AUDIO_DURATION_MS: Joi.number()
    .integer()
    .min(1000)
    .max(900000)
    .default(900000),
  CORS_ORIGINS: Joi.string().allow('').default(''),
  TRUST_PROXY: Joi.string().allow('').default('loopback'),
}).unknown(true);

export function validateEnvironment(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const { error, value } = environmentSchema.validate(config, {
    abortEarly: false,
    convert: true,
  });

  if (error) {
    throw new Error(`Environment validation failed: ${error.message}`);
  }

  const environment = value as Record<string, unknown>;
  if (
    environment.NODE_ENV === 'production' &&
    environment.OTP_PROVIDER === 'console'
  ) {
    throw new Error(
      'OTP_PROVIDER=console is not allowed in production. Configure OTP_PROVIDER=twilio.',
    );
  }

  if (
    environment.NODE_ENV === 'production' &&
    typeof environment.AUTH_FIXED_OTP === 'string' &&
    environment.AUTH_FIXED_OTP.length > 0
  ) {
    throw new Error('AUTH_FIXED_OTP must be empty in production.');
  }

  if (
    environment.NODE_ENV === 'production' &&
    typeof environment.AUTH_OTP_LENGTH === 'number' &&
    environment.AUTH_OTP_LENGTH < 6
  ) {
    throw new Error('AUTH_OTP_LENGTH must be at least 6 in production.');
  }

  if (
    typeof environment.AUTH_FIXED_OTP === 'string' &&
    environment.AUTH_FIXED_OTP.length > 0 &&
    environment.AUTH_FIXED_OTP.length !== environment.AUTH_OTP_LENGTH
  ) {
    throw new Error('AUTH_FIXED_OTP must match AUTH_OTP_LENGTH.');
  }

  return environment;
}

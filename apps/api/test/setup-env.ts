process.env.NODE_ENV = 'test';
process.env.PORT = '3001';
process.env.DATABASE_URL =
  'postgresql://chateo:chateo@localhost:5432/chateo_test?schema=public';
process.env.JWT_ACCESS_SECRET =
  'test-access-secret-that-is-at-least-thirty-two-characters';
process.env.OTP_HASH_SECRET =
  'test-otp-secret-that-is-at-least-thirty-two-characters';
process.env.AUTH_FIXED_OTP = '2468';
process.env.OTP_PROVIDER = 'console';
process.env.AUTH_OTP_LENGTH = '4';
process.env.AUTH_OTP_TTL_SECONDS = '300';
process.env.AUTH_OTP_RESEND_SECONDS = '24';
process.env.AUTH_OTP_MAX_ATTEMPTS = '5';
process.env.AUTH_OTP_LOCK_SECONDS = '900';
process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS = '900';
process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS = '2592000';

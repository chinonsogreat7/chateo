export type AuthDevicePlatform = 'IOS' | 'ANDROID' | 'WEB' | 'UNKNOWN';
export type AuthSessionRevocationReason =
  | 'ROTATED'
  | 'LOGOUT'
  | 'REUSE_DETECTED'
  | 'ADMIN';

export interface AuthUserRecord {
  id: string;
  phoneNumber: string;
  phoneVerifiedAt: Date;
  displayName: string | null;
  avatarUrl: string | null;
  profileCompletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OtpChallengeRecord {
  id: string;
  phoneNumber: string;
  codeDigest: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  attemptsRemaining: number;
  lastSentAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

export interface OtpAttemptBudgetRecord {
  phoneNumber: string;
  failedAttempts: number;
  lockedUntil: Date | null;
}

export interface FailedOtpAttemptResult {
  failedAttempts: number;
  attemptsRemaining: number;
  lockedUntil: Date | null;
}

export type ReplaceOtpChallengeResult =
  | { status: 'created'; challenge: OtpChallengeRecord }
  | { status: 'cooldown'; retryAfterSeconds: number };

export interface AuthSessionRecord {
  id: string;
  familyId: string;
  userId: string;
  tokenDigest: string;
  deviceName: string | null;
  platform: AuthDevicePlatform;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  lastUsedAt: Date;
  revokedAt: Date | null;
  revokedReason: AuthSessionRevocationReason | null;
}

export interface CreateOtpChallengeInput {
  id: string;
  phoneNumber: string;
  codeDigest: string;
  expiresAt: Date;
  resendAvailableAt: Date;
  attemptsRemaining: number;
  lastSentAt: Date;
}

export interface CreateAuthSessionInput {
  id: string;
  familyId: string;
  userId: string;
  tokenDigest: string;
  deviceName?: string;
  platform: AuthDevicePlatform;
  ipAddress?: string;
  userAgent?: string;
  expiresAt: Date;
  lastUsedAt: Date;
}

export interface CompleteVerificationResult {
  user: AuthUserRecord;
  session: AuthSessionRecord;
}

export interface UpdateProfileInput {
  displayName?: string;
  avatarUrl?: string | null;
}

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

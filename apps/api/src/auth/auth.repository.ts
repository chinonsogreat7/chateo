import type {
  AuthSessionRecord,
  AuthSessionRevocationReason,
  AuthUserRecord,
  CompleteVerificationResult,
  CreateAuthSessionInput,
  CreateOtpChallengeInput,
  FailedOtpAttemptResult,
  OtpAttemptBudgetRecord,
  OtpChallengeRecord,
  ReplaceOtpChallengeResult,
  UpdateProfileInput,
} from './auth.types';

export abstract class AuthRepository {
  abstract getLatestOtpChallenge(
    phoneNumber: string,
  ): Promise<OtpChallengeRecord | null>;

  abstract getOtpChallenge(id: string): Promise<OtpChallengeRecord | null>;

  abstract invalidateOtpChallenge(id: string, now: Date): Promise<void>;

  abstract replaceActiveOtpChallenge(
    input: CreateOtpChallengeInput,
    now: Date,
  ): Promise<ReplaceOtpChallengeResult>;

  abstract getOtpAttemptBudget(
    phoneNumber: string,
  ): Promise<OtpAttemptBudgetRecord | null>;

  abstract resetOtpAttemptBudget(phoneNumber: string): Promise<void>;

  abstract recordFailedOtpAttempt(
    challengeId: string,
    phoneNumber: string,
    maxAttempts: number,
    lockedUntil: Date,
    now: Date,
  ): Promise<FailedOtpAttemptResult | null>;

  abstract completeVerification(
    challengeId: string,
    phoneNumber: string,
    session: Omit<CreateAuthSessionInput, 'userId'>,
    now: Date,
  ): Promise<CompleteVerificationResult | null>;

  abstract getSession(id: string): Promise<AuthSessionRecord | null>;

  abstract rotateSession(
    currentSessionId: string,
    session: CreateAuthSessionInput,
    now: Date,
  ): Promise<CompleteVerificationResult | null>;

  abstract revokeSession(
    id: string,
    now: Date,
    reason: AuthSessionRevocationReason,
  ): Promise<void>;

  abstract revokeSessionFamily(
    familyId: string,
    now: Date,
    reason: AuthSessionRevocationReason,
  ): Promise<void>;

  abstract isSessionActive(
    sessionId: string,
    userId: string,
    now: Date,
  ): Promise<boolean>;

  abstract findUserById(id: string): Promise<AuthUserRecord | null>;

  abstract updateUserProfile(
    id: string,
    input: UpdateProfileInput,
    now: Date,
  ): Promise<AuthUserRecord | null>;
}

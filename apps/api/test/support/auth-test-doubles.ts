import { randomUUID } from 'node:crypto';
import { AuthRepository } from '../../src/auth/auth.repository';
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
} from '../../src/auth/auth.types';
import { Clock } from '../../src/auth/providers/clock';
import {
  type DeliverOtpInput,
  OtpDeliveryProvider,
} from '../../src/auth/providers/otp-delivery.provider';

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function copyOptionalDate(value: Date | null): Date | null {
  return value ? copyDate(value) : null;
}

function copyChallenge(challenge: OtpChallengeRecord): OtpChallengeRecord {
  return {
    ...challenge,
    expiresAt: copyDate(challenge.expiresAt),
    resendAvailableAt: copyDate(challenge.resendAvailableAt),
    lastSentAt: copyDate(challenge.lastSentAt),
    consumedAt: copyOptionalDate(challenge.consumedAt),
    createdAt: copyDate(challenge.createdAt),
  };
}

function copyBudget(budget: OtpAttemptBudgetRecord): OtpAttemptBudgetRecord {
  return {
    ...budget,
    lockedUntil: copyOptionalDate(budget.lockedUntil),
  };
}

function copyUser(user: AuthUserRecord): AuthUserRecord {
  return {
    ...user,
    phoneVerifiedAt: copyDate(user.phoneVerifiedAt),
    profileCompletedAt: copyOptionalDate(user.profileCompletedAt),
    createdAt: copyDate(user.createdAt),
    updatedAt: copyDate(user.updatedAt),
  };
}

function copySession(session: AuthSessionRecord): AuthSessionRecord {
  return {
    ...session,
    expiresAt: copyDate(session.expiresAt),
    lastUsedAt: copyDate(session.lastUsedAt),
    revokedAt: copyOptionalDate(session.revokedAt),
  };
}

/**
 * A transaction-like test repository that mirrors the observable semantics of
 * PrismaAuthRepository without opening a database connection.
 */
export class InMemoryAuthRepository extends AuthRepository {
  private readonly challenges = new Map<string, OtpChallengeRecord>();
  private readonly attemptBudgets = new Map<string, OtpAttemptBudgetRecord>();
  private readonly users = new Map<string, AuthUserRecord>();
  private readonly userIdsByPhone = new Map<string, string>();
  private readonly sessions = new Map<string, AuthSessionRecord>();

  get challengeRecords(): OtpChallengeRecord[] {
    return [...this.challenges.values()].map(copyChallenge);
  }

  get sessionRecords(): AuthSessionRecord[] {
    return [...this.sessions.values()].map(copySession);
  }

  inspectSession(id: string): AuthSessionRecord | null {
    const session = this.sessions.get(id);
    return session ? copySession(session) : null;
  }

  seedSession(session: AuthSessionRecord): void {
    this.sessions.set(session.id, copySession(session));
  }

  override async getLatestOtpChallenge(
    phoneNumber: string,
  ): Promise<OtpChallengeRecord | null> {
    const matches = [...this.challenges.values()].filter(
      (challenge) => challenge.phoneNumber === phoneNumber,
    );
    const latest = matches.at(-1);
    return latest ? copyChallenge(latest) : null;
  }

  override async getOtpChallenge(
    id: string,
  ): Promise<OtpChallengeRecord | null> {
    const challenge = this.challenges.get(id);
    return challenge ? copyChallenge(challenge) : null;
  }

  override async invalidateOtpChallenge(id: string, now: Date): Promise<void> {
    const challenge = this.challenges.get(id);
    if (challenge && !challenge.consumedAt) {
      challenge.consumedAt = copyDate(now);
    }
  }

  override async replaceActiveOtpChallenge(
    input: CreateOtpChallengeInput,
    now: Date,
  ): Promise<ReplaceOtpChallengeResult> {
    const active = [...this.challenges.values()]
      .filter(
        (challenge) =>
          challenge.phoneNumber === input.phoneNumber && !challenge.consumedAt,
      )
      .at(-1);
    if (active && active.resendAvailableAt.getTime() > now.getTime()) {
      return {
        status: 'cooldown',
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            (active.resendAvailableAt.getTime() - now.getTime()) / 1000,
          ),
        ),
      };
    }

    for (const challenge of this.challenges.values()) {
      if (
        challenge.phoneNumber === input.phoneNumber &&
        !challenge.consumedAt
      ) {
        challenge.consumedAt = copyDate(now);
      }
    }

    const challenge: OtpChallengeRecord = {
      ...input,
      expiresAt: copyDate(input.expiresAt),
      resendAvailableAt: copyDate(input.resendAvailableAt),
      lastSentAt: copyDate(input.lastSentAt),
      consumedAt: null,
      createdAt: copyDate(input.lastSentAt),
    };
    this.challenges.set(challenge.id, challenge);
    return { status: 'created', challenge: copyChallenge(challenge) };
  }

  override async getOtpAttemptBudget(
    phoneNumber: string,
  ): Promise<OtpAttemptBudgetRecord | null> {
    const budget = this.attemptBudgets.get(phoneNumber);
    return budget ? copyBudget(budget) : null;
  }

  override async resetOtpAttemptBudget(phoneNumber: string): Promise<void> {
    const budget = this.attemptBudgets.get(phoneNumber);
    if (budget) {
      budget.failedAttempts = 0;
      budget.lockedUntil = null;
    }
  }

  override async recordFailedOtpAttempt(
    challengeId: string,
    phoneNumber: string,
    maxAttempts: number,
    lockedUntil: Date,
    now: Date,
  ): Promise<FailedOtpAttemptResult | null> {
    const challenge = this.challenges.get(challengeId);
    if (
      !challenge ||
      challenge.phoneNumber !== phoneNumber ||
      challenge.consumedAt ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attemptsRemaining <= 0
    ) {
      return null;
    }

    const current = this.attemptBudgets.get(phoneNumber);
    const failedAttempts = Math.min(
      maxAttempts,
      (current?.failedAttempts ?? 0) + 1,
    );
    const attemptsRemaining = Math.max(0, maxAttempts - failedAttempts);
    const nextLockedUntil =
      attemptsRemaining === 0 ? copyDate(lockedUntil) : null;

    this.attemptBudgets.set(phoneNumber, {
      phoneNumber,
      failedAttempts,
      lockedUntil: nextLockedUntil,
    });

    challenge.attemptsRemaining = attemptsRemaining;

    return {
      failedAttempts,
      attemptsRemaining,
      lockedUntil: copyOptionalDate(nextLockedUntil),
    };
  }

  override async completeVerification(
    challengeId: string,
    phoneNumber: string,
    session: Omit<CreateAuthSessionInput, 'userId'>,
    now: Date,
  ): Promise<CompleteVerificationResult | null> {
    const challenge = this.challenges.get(challengeId);
    if (
      !challenge ||
      challenge.phoneNumber !== phoneNumber ||
      challenge.consumedAt ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.attemptsRemaining <= 0
    ) {
      return null;
    }

    challenge.consumedAt = copyDate(now);

    const existingUserId = this.userIdsByPhone.get(phoneNumber);
    let user = existingUserId ? this.users.get(existingUserId) : undefined;
    if (user) {
      user.updatedAt = copyDate(now);
    } else {
      user = {
        id: randomUUID(),
        phoneNumber,
        phoneVerifiedAt: copyDate(now),
        displayName: null,
        avatarUrl: null,
        profileCompletedAt: null,
        createdAt: copyDate(now),
        updatedAt: copyDate(now),
      };
      this.users.set(user.id, user);
      this.userIdsByPhone.set(phoneNumber, user.id);
    }

    this.attemptBudgets.set(phoneNumber, {
      phoneNumber,
      failedAttempts: 0,
      lockedUntil: null,
    });

    const createdSession = this.createSessionRecord(session, user.id);
    this.sessions.set(createdSession.id, createdSession);
    return {
      user: copyUser(user),
      session: copySession(createdSession),
    };
  }

  override async getSession(id: string): Promise<AuthSessionRecord | null> {
    const session = this.sessions.get(id);
    return session ? copySession(session) : null;
  }

  override async rotateSession(
    currentSessionId: string,
    session: CreateAuthSessionInput,
    now: Date,
  ): Promise<CompleteVerificationResult | null> {
    const current = this.sessions.get(currentSessionId);
    if (
      !current ||
      current.userId !== session.userId ||
      current.familyId !== session.familyId ||
      current.revokedAt ||
      current.expiresAt.getTime() <= now.getTime()
    ) {
      return null;
    }

    const user = this.users.get(session.userId);
    if (!user) return null;

    current.revokedAt = copyDate(now);
    current.revokedReason = 'ROTATED';
    current.lastUsedAt = copyDate(now);

    const createdSession = this.createSessionRecord(session, session.userId);
    this.sessions.set(createdSession.id, createdSession);
    return {
      user: copyUser(user),
      session: copySession(createdSession),
    };
  }

  override async revokeSession(
    id: string,
    now: Date,
    reason: AuthSessionRevocationReason,
  ): Promise<void> {
    const session = this.sessions.get(id);
    if (session && !session.revokedAt) {
      session.revokedAt = copyDate(now);
      session.revokedReason = reason;
    }
  }

  override async revokeSessionFamily(
    familyId: string,
    now: Date,
    reason: AuthSessionRevocationReason,
  ): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.familyId === familyId && !session.revokedAt) {
        session.revokedAt = copyDate(now);
        session.revokedReason = reason;
      }
    }
  }

  override async isSessionActive(
    sessionId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    return Boolean(
      session &&
        session.userId === userId &&
        !session.revokedAt &&
        session.expiresAt.getTime() > now.getTime(),
    );
  }

  override async findUserById(id: string): Promise<AuthUserRecord | null> {
    const user = this.users.get(id);
    return user ? copyUser(user) : null;
  }

  override async updateUserProfile(
    id: string,
    input: UpdateProfileInput,
    now: Date,
  ): Promise<AuthUserRecord | null> {
    const user = this.users.get(id);
    if (!user) return null;

    if (input.displayName !== undefined) {
      user.displayName = input.displayName;
      if (!user.profileCompletedAt) user.profileCompletedAt = copyDate(now);
    }
    if (input.avatarUrl !== undefined) user.avatarUrl = input.avatarUrl;
    user.updatedAt = copyDate(now);
    return copyUser(user);
  }

  private createSessionRecord(
    session: Omit<CreateAuthSessionInput, 'userId'>,
    userId: string,
  ): AuthSessionRecord;
  private createSessionRecord(
    session: CreateAuthSessionInput,
    userId: string,
  ): AuthSessionRecord;
  private createSessionRecord(
    session: CreateAuthSessionInput | Omit<CreateAuthSessionInput, 'userId'>,
    userId: string,
  ): AuthSessionRecord {
    return {
      id: session.id,
      familyId: session.familyId,
      userId,
      tokenDigest: session.tokenDigest,
      deviceName: session.deviceName ?? null,
      platform: session.platform,
      ipAddress: session.ipAddress ?? null,
      userAgent: session.userAgent ?? null,
      expiresAt: copyDate(session.expiresAt),
      lastUsedAt: copyDate(session.lastUsedAt),
      revokedAt: null,
      revokedReason: null,
    };
  }
}

export class ManualClock extends Clock {
  private current: Date;

  constructor(initial: Date) {
    super();
    this.current = copyDate(initial);
  }

  override now(): Date {
    return copyDate(this.current);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

export interface DeliveredOtp {
  phoneNumber: string;
  code: string;
  expiresAt: Date;
}

export class InspectableOtpDeliveryProvider extends OtpDeliveryProvider {
  readonly deliveries: DeliveredOtp[] = [];

  override async send(input: DeliverOtpInput): Promise<void> {
    this.deliveries.push({
      ...input,
      expiresAt: copyDate(input.expiresAt),
    });
  }
}

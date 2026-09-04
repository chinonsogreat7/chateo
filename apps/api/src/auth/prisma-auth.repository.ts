import { Injectable } from '@nestjs/common';
import {
  DevicePlatform,
  Prisma,
  SessionRevocationReason,
  type AuthSession,
  type OtpChallenge,
  type User,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuthRepository } from './auth.repository';
import type { AuthSessionIdentity } from './auth.repository';
import type {
  AuthDevicePlatform,
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

function mapUser(user: User): AuthUserRecord {
  return {
    id: user.id,
    phoneNumber: user.phoneNumber,
    phoneVerifiedAt: user.phoneVerifiedAt,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profileCompletedAt: user.profileCompletedAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function mapOtpChallenge(challenge: OtpChallenge): OtpChallengeRecord {
  return {
    id: challenge.id,
    phoneNumber: challenge.phoneNumber,
    codeDigest: challenge.codeDigest,
    expiresAt: challenge.expiresAt,
    resendAvailableAt: challenge.resendAvailableAt,
    attemptsRemaining: challenge.attemptsRemaining,
    lastSentAt: challenge.lastSentAt,
    consumedAt: challenge.consumedAt,
    createdAt: challenge.createdAt,
  };
}

function mapSession(session: AuthSession): AuthSessionRecord {
  return {
    id: session.id,
    familyId: session.familyId,
    userId: session.userId,
    tokenDigest: session.tokenDigest,
    deviceName: session.deviceName,
    platform: session.platform as AuthDevicePlatform,
    ipAddress: session.ipAddress,
    userAgent: session.userAgent,
    expiresAt: session.expiresAt,
    lastUsedAt: session.lastUsedAt,
    revokedAt: session.revokedAt,
    revokedReason: session.revokedReason as AuthSessionRevocationReason | null,
  };
}

function mapPlatform(platform: AuthDevicePlatform): DevicePlatform {
  return DevicePlatform[platform];
}

function mapRevocationReason(
  reason: AuthSessionRevocationReason,
): SessionRevocationReason {
  return SessionRevocationReason[reason];
}

@Injectable()
export class PrismaAuthRepository extends AuthRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async getLatestOtpChallenge(
    phoneNumber: string,
  ): Promise<OtpChallengeRecord | null> {
    const challenge = await this.prisma.otpChallenge.findFirst({
      where: { phoneNumber },
      orderBy: { createdAt: 'desc' },
    });
    return challenge ? mapOtpChallenge(challenge) : null;
  }

  async getOtpChallenge(id: string): Promise<OtpChallengeRecord | null> {
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { id },
    });
    return challenge ? mapOtpChallenge(challenge) : null;
  }

  async invalidateOtpChallenge(id: string, now: Date): Promise<void> {
    await this.prisma.otpChallenge.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: now },
    });
  }

  replaceActiveOtpChallenge(
    input: CreateOtpChallengeInput,
    now: Date,
  ): Promise<ReplaceOtpChallengeResult> {
    return this.runSerializable(
      async (transaction) => {
        const active = await transaction.otpChallenge.findFirst({
          where: { phoneNumber: input.phoneNumber, consumedAt: null },
          orderBy: { createdAt: 'desc' },
        });
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

        await transaction.otpChallenge.updateMany({
          where: { phoneNumber: input.phoneNumber, consumedAt: null },
          data: { consumedAt: now },
        });
        const challenge = await transaction.otpChallenge.create({
          data: input,
        });
        return { status: 'created', challenge: mapOtpChallenge(challenge) };
      },
      { retryUniqueConflicts: true },
    );
  }

  async getOtpAttemptBudget(
    phoneNumber: string,
  ): Promise<OtpAttemptBudgetRecord | null> {
    const budget = await this.prisma.otpAttemptBudget.findUnique({
      where: { phoneNumber },
    });
    return budget
      ? {
          phoneNumber: budget.phoneNumber,
          failedAttempts: budget.failedAttempts,
          lockedUntil: budget.lockedUntil,
        }
      : null;
  }

  async resetOtpAttemptBudget(phoneNumber: string): Promise<void> {
    await this.prisma.otpAttemptBudget.updateMany({
      where: { phoneNumber },
      data: { failedAttempts: 0, lockedUntil: null },
    });
  }

  recordFailedOtpAttempt(
    challengeId: string,
    phoneNumber: string,
    maxAttempts: number,
    lockedUntil: Date,
    now: Date,
  ): Promise<FailedOtpAttemptResult | null> {
    return this.runSerializable(async (transaction) => {
      const reserved = await transaction.otpChallenge.updateMany({
        where: {
          id: challengeId,
          phoneNumber,
          consumedAt: null,
          expiresAt: { gt: now },
          attemptsRemaining: { gt: 0 },
        },
        data: { attemptsRemaining: { decrement: 1 } },
      });
      if (reserved.count !== 1) return null;

      const current = await transaction.otpAttemptBudget.findUnique({
        where: { phoneNumber },
      });
      const failedAttempts = Math.min(
        maxAttempts,
        (current?.failedAttempts ?? 0) + 1,
      );
      const attemptsRemaining = Math.max(0, maxAttempts - failedAttempts);
      const nextLockedUntil = attemptsRemaining === 0 ? lockedUntil : null;

      await transaction.otpAttemptBudget.upsert({
        where: { phoneNumber },
        create: {
          phoneNumber,
          failedAttempts,
          lockedUntil: nextLockedUntil,
        },
        update: {
          failedAttempts,
          lockedUntil: nextLockedUntil,
        },
      });
      await transaction.otpChallenge.update({
        where: { id: challengeId },
        data: { attemptsRemaining },
      });

      return {
        failedAttempts,
        attemptsRemaining,
        lockedUntil: nextLockedUntil,
      };
    });
  }

  completeVerification(
    challengeId: string,
    phoneNumber: string,
    session: Omit<CreateAuthSessionInput, 'userId'>,
    now: Date,
  ): Promise<CompleteVerificationResult | null> {
    return this.runSerializable(async (transaction) => {
      const consumed = await transaction.otpChallenge.updateMany({
        where: {
          id: challengeId,
          phoneNumber,
          consumedAt: null,
          expiresAt: { gt: now },
          attemptsRemaining: { gt: 0 },
        },
        data: { consumedAt: now },
      });
      if (consumed.count !== 1) return null;

      const user = await transaction.user.upsert({
        where: { phoneNumber },
        create: { phoneNumber, phoneVerifiedAt: now },
        update: { updatedAt: now },
      });
      await transaction.otpAttemptBudget.upsert({
        where: { phoneNumber },
        create: { phoneNumber, failedAttempts: 0 },
        update: { failedAttempts: 0, lockedUntil: null },
      });
      const createdSession = await transaction.authSession.create({
        data: {
          ...session,
          userId: user.id,
          platform: mapPlatform(session.platform),
        },
      });
      return {
        user: mapUser(user),
        session: mapSession(createdSession),
      };
    });
  }

  async getSession(id: string): Promise<AuthSessionRecord | null> {
    const session = await this.prisma.authSession.findUnique({ where: { id } });
    return session ? mapSession(session) : null;
  }

  rotateSession(
    currentSessionId: string,
    session: CreateAuthSessionInput,
    now: Date,
  ): Promise<CompleteVerificationResult | null> {
    return this.runSerializable(async (transaction) => {
      const updated = await transaction.authSession.updateMany({
        where: {
          id: currentSessionId,
          userId: session.userId,
          familyId: session.familyId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: {
          revokedAt: now,
          revokedReason: SessionRevocationReason.ROTATED,
          lastUsedAt: now,
        },
      });
      if (updated.count !== 1) return null;

      const createdSession = await transaction.authSession.create({
        data: {
          ...session,
          platform: mapPlatform(session.platform),
        },
      });
      await transaction.authSession.update({
        where: { id: currentSessionId },
        data: { replacedById: createdSession.id },
      });
      const user = await transaction.user.findUnique({
        where: { id: session.userId },
      });
      if (!user) return null;

      return {
        user: mapUser(user),
        session: mapSession(createdSession),
      };
    });
  }

  async revokeSession(
    id: string,
    now: Date,
    reason: AuthSessionRevocationReason,
  ): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { id, revokedAt: null },
      data: {
        revokedAt: now,
        revokedReason: mapRevocationReason(reason),
      },
    });
  }

  async revokeSessionFamily(
    familyId: string,
    now: Date,
    reason: AuthSessionRevocationReason,
  ): Promise<void> {
    await this.prisma.authSession.updateMany({
      where: { familyId, revokedAt: null },
      data: {
        revokedAt: now,
        revokedReason: mapRevocationReason(reason),
      },
    });
  }

  private async runSerializable<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
    options: { retryUniqueConflicts?: boolean } = {},
  ): Promise<T> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        const code =
          error instanceof Prisma.PrismaClientKnownRequestError
            ? error.code
            : undefined;
        const retryable =
          code === 'P2034' ||
          (options.retryUniqueConflicts === true && code === 'P2002');
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async isSessionActive(
    sessionId: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const session = await this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
    return session !== null;
  }

  async findActiveSessionIds(
    sessions: readonly AuthSessionIdentity[],
    now: Date,
  ): Promise<string[]> {
    const expectedUserIdBySessionId = new Map(
      sessions.map(({ sessionId, userId }) => [
        sessionId.toLowerCase(),
        userId.toLowerCase(),
      ]),
    );
    if (expectedUserIdBySessionId.size === 0) return [];

    const activeSessions = await this.prisma.authSession.findMany({
      where: {
        id: { in: [...expectedUserIdBySessionId.keys()] },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true, userId: true },
    });
    return activeSessions
      .filter(
        (session) =>
          expectedUserIdBySessionId.get(session.id) === session.userId,
      )
      .map((session) => session.id);
  }

  async findUserById(id: string): Promise<AuthUserRecord | null> {
    const user = await this.prisma.user.findUnique({ where: { id } });
    return user ? mapUser(user) : null;
  }

  async updateUserProfile(
    id: string,
    input: UpdateProfileInput,
    now: Date,
  ): Promise<AuthUserRecord | null> {
    const existing = await this.prisma.user.findUnique({
      where: { id },
      select: { id: true, profileCompletedAt: true },
    });
    if (!existing) return null;

    const data: Prisma.UserUpdateInput = {};
    if (input.displayName !== undefined) {
      data.displayName = input.displayName;
      if (existing.profileCompletedAt === null) data.profileCompletedAt = now;
    }
    if (input.avatarUrl !== undefined) data.avatarUrl = input.avatarUrl;

    const user = await this.prisma.user.update({ where: { id }, data });
    return mapUser(user);
  }
}

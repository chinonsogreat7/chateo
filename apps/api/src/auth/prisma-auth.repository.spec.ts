import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaAuthRepository } from './prisma-auth.repository';
import type { CreateOtpChallengeInput } from './auth.types';

type TransactionRunner = (
  operation: (transaction: Prisma.TransactionClient) => Promise<unknown>,
  options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
) => Promise<unknown>;

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function createRepository() {
  const transaction = jest.fn<
    ReturnType<TransactionRunner>,
    Parameters<TransactionRunner>
  >();
  const repository = new PrismaAuthRepository({
    $transaction: transaction,
  } as unknown as PrismaService);

  return { repository, transaction };
}

function failedAttemptTransaction(): Prisma.TransactionClient {
  return {
    otpChallenge: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as Prisma.TransactionClient;
}

const now = new Date('2026-08-09T12:00:00.000Z');
const lockedUntil = new Date('2026-08-09T12:15:00.000Z');
const otpInput: CreateOtpChallengeInput = {
  id: 'challenge-1',
  phoneNumber: '+2348012345678',
  codeDigest: 'otp-digest',
  expiresAt: new Date('2026-08-09T12:05:00.000Z'),
  resendAvailableAt: new Date('2026-08-09T12:00:24.000Z'),
  attemptsRemaining: 5,
  lastSentAt: now,
};

describe('PrismaAuthRepository serializable transaction retries', () => {
  it('retries P2034 conflicts and succeeds on the third attempt', async () => {
    const { repository, transaction } = createRepository();
    const transactionClient = failedAttemptTransaction();
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(async (operation) =>
        operation(transactionClient),
      );

    await expect(
      repository.recordFailedOtpAttempt(
        'challenge-1',
        '+2348012345678',
        5,
        lockedUntil,
        now,
      ),
    ).resolves.toBeNull();

    expect(transaction).toHaveBeenCalledTimes(3);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('stops after the third P2034 conflict', async () => {
    const { repository, transaction } = createRepository();
    const error = knownRequestError('P2034');
    transaction.mockRejectedValue(error);

    await expect(
      repository.recordFailedOtpAttempt(
        'challenge-1',
        '+2348012345678',
        5,
        lockedUntil,
        now,
      ),
    ).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('propagates non-retryable errors immediately', async () => {
    const { repository, transaction } = createRepository();
    const error = new Error('connection unavailable');
    transaction.mockRejectedValue(error);

    await expect(
      repository.recordFailedOtpAttempt(
        'challenge-1',
        '+2348012345678',
        5,
        lockedUntil,
        now,
      ),
    ).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('retries P2002 for active challenge replacement', async () => {
    const { repository, transaction } = createRepository();
    const findFirst = jest.fn().mockResolvedValue({
      resendAvailableAt: otpInput.resendAvailableAt,
    });
    const transactionClient = {
      otpChallenge: { findFirst },
    } as unknown as Prisma.TransactionClient;
    transaction
      .mockRejectedValueOnce(knownRequestError('P2002'))
      .mockImplementationOnce(async (operation) =>
        operation(transactionClient),
      );

    await expect(
      repository.replaceActiveOtpChallenge(otpInput, now),
    ).resolves.toEqual({ status: 'cooldown', retryAfterSeconds: 24 });

    expect(transaction).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledTimes(1);
  });

  it('does not retry P2002 for other serializable operations', async () => {
    const { repository, transaction } = createRepository();
    const error = knownRequestError('P2002');
    transaction.mockRejectedValue(error);

    await expect(
      repository.recordFailedOtpAttempt(
        'challenge-1',
        '+2348012345678',
        5,
        lockedUntil,
        now,
      ),
    ).rejects.toBe(error);

    expect(transaction).toHaveBeenCalledTimes(1);
  });
});

describe('PrismaAuthRepository active-session batching', () => {
  it('loads active sessions once and verifies each session-user pair', async () => {
    const findMany = jest.fn().mockResolvedValue([
      { id: 'session-one', userId: 'user-one' },
      { id: 'session-two', userId: 'different-user' },
    ]);
    const repository = new PrismaAuthRepository({
      authSession: { findMany },
    } as unknown as PrismaService);

    await expect(
      repository.findActiveSessionIds(
        [
          { sessionId: 'SESSION-ONE', userId: 'USER-ONE' },
          { sessionId: 'session-two', userId: 'user-two' },
        ],
        now,
      ),
    ).resolves.toEqual(['session-one']);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['session-one', 'session-two'] },
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { id: true, userId: true },
    });
  });
});

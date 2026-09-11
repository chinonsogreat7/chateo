import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../auth/providers/clock';
import { PushProvider } from './expo-push.provider';
import { PushPresenceService } from './push-presence.service';
import { PushRepository, type LeasedPush } from './push.repository';
import { PushWorkerService } from './push-worker.service';
import { PUSH_JOB_MAX_AGE_MS, PUSH_RECEIPT_DELAY_MS } from './push-policy';

const NOW = new Date('2026-09-11T12:00:00Z');
function job(overrides: Partial<LeasedPush> = {}): LeasedPush {
  return {
    id: 'job',
    messageId: 'message',
    deviceId: 'device',
    deviceVersion: 1,
    status: 'PENDING',
    attempts: 1,
    nextAttemptAt: NOW,
    leaseToken: 'lease',
    leaseUntil: new Date(NOW.getTime() + 120000),
    ticketId: null,
    ticketAt: null,
    errorCode: null,
    completedAt: null,
    createdAt: new Date(NOW.getTime() - 15000),
    ...overrides,
  };
}
function setup(work = job(), enabled = true) {
  const repo = {
    claimDue: jest.fn().mockResolvedValue([work]),
    eligible: jest.fn().mockResolvedValue({
      userId: 'recipient',
      token: 'secret-token',
      conversationId: 'chat',
      messageId: 'message',
    }),
    finish: jest.fn(),
    invalidateDevice: jest.fn(),
    ownsLease: jest.fn().mockResolvedValue(true),
  };
  const provider = {
    send: jest
      .fn()
      .mockResolvedValue({ status: 'accepted', ticketId: 'ticket' }),
    receipt: jest.fn().mockResolvedValue({ status: 'ok' }),
  };
  const presence = { isOnline: jest.fn().mockResolvedValue(false) };
  const worker = new PushWorkerService(
    repo as unknown as PushRepository,
    provider as PushProvider,
    presence as unknown as PushPresenceService,
    { now: () => NOW } as Clock,
    new ConfigService({ PUSH_NOTIFICATIONS_ENABLED: enabled }),
  );
  return { repo, provider, presence, worker };
}
describe('Push delivery worker', () => {
  it('reschedules an explicitly rate-rejected receipt as a policy-checked send', async () => {
    const work = job({ status: 'RECEIPT', ticketId: 'ticket', ticketAt: NOW });
    const { worker, repo, provider } = setup(work);
    provider.receipt.mockResolvedValue({
      status: 'error',
      code: 'MessageRateExceeded',
      retryable: true,
    });
    await worker.sweepOnce();
    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(work, {
      status: 'PENDING',
      ticketId: null,
      ticketAt: null,
      errorCode: 'MessageRateExceeded',
      nextAttemptAt: new Date(NOW.getTime() + 30000),
    });
  });
  beforeEach(() =>
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined),
  );
  afterEach(() => jest.restoreAllMocks());
  it('sends only an eligible offline notification, then schedules a receipt check', async () => {
    const { worker, repo, provider } = setup();
    await worker.sweepOnce();
    expect(provider.send).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'recipient' }),
      'job',
    );
    expect(repo.finish).toHaveBeenCalledWith(job(), {
      status: 'RECEIPT',
      ticketId: 'ticket',
      ticketAt: NOW,
      nextAttemptAt: new Date(NOW.getTime() + PUSH_RECEIPT_DELAY_MS),
      errorCode: null,
    });
  });
  it.each(['ineligible', 'online', 'lease lost', 'disabled', 'expired'])(
    'does not send when %s',
    async (reason) => {
      const work =
        reason === 'expired'
          ? job({ createdAt: new Date(NOW.getTime() - PUSH_JOB_MAX_AGE_MS) })
          : job();
      const { worker, repo, provider, presence } = setup(
        work,
        reason !== 'disabled',
      );
      if (reason === 'ineligible') repo.eligible.mockResolvedValue(null);
      if (reason === 'online') presence.isOnline.mockResolvedValue(true);
      if (reason === 'lease lost') repo.ownsLease.mockResolvedValue(false);
      await worker.sweepOnce();
      expect(provider.send).not.toHaveBeenCalled();
    },
  );
  it('fails closed on presence errors and retries with backoff', async () => {
    const { worker, repo, provider, presence } = setup();
    presence.isOnline.mockRejectedValue(new Error('lookup unavailable'));
    await worker.sweepOnce();
    expect(provider.send).not.toHaveBeenCalled();
    expect(repo.finish).toHaveBeenCalledWith(job(), {
      errorCode: 'WorkerError',
      nextAttemptAt: new Date(NOW.getTime() + 30000),
    });
  });
  it.each([1, 6])(
    'bounds retryable provider failures at attempt %i',
    async (attempts) => {
      const work = job({ attempts });
      const { worker, repo, provider } = setup(work);
      provider.send.mockResolvedValue({
        status: 'error',
        code: 'HTTP_429',
        retryable: true,
      });
      await worker.sweepOnce();
      expect(repo.finish).toHaveBeenCalledWith(
        work,
        attempts === 6
          ? { status: 'FAILED', errorCode: 'HTTP_429', completedAt: NOW }
          : {
              errorCode: 'HTTP_429',
              nextAttemptAt: new Date(NOW.getTime() + 30000),
            },
      );
    },
  );
  it.each(['PENDING', 'RECEIPT'] as const)(
    'disables an invalid registration from a %s response',
    async (status) => {
      const work = job({ status, ticketId: 'ticket', ticketAt: NOW });
      const { worker, repo, provider } = setup(work);
      provider.send.mockResolvedValue({
        status: 'error',
        code: 'DeviceNotRegistered',
        retryable: false,
      });
      provider.receipt.mockResolvedValue({
        status: 'error',
        code: 'DeviceNotRegistered',
        retryable: false,
      });
      await worker.sweepOnce();
      expect(repo.invalidateDevice).toHaveBeenCalledWith(work, NOW);
      expect(repo.finish).toHaveBeenCalledWith(work, {
        status: 'FAILED',
        errorCode: 'DeviceNotRegistered',
        completedAt: NOW,
      });
    },
  );
  it.each(['ok', 'pending', 'error'])(
    'polls a %s receipt without resending the notification',
    async (status) => {
      const work = job({
        status: 'RECEIPT',
        ticketId: 'ticket',
        ticketAt: NOW,
      });
      const { worker, repo, provider } = setup(work);
      provider.receipt.mockResolvedValue({
        status,
        code: 'HTTP_503',
        retryable: true,
      });
      await worker.sweepOnce();
      expect(provider.send).not.toHaveBeenCalled();
      expect(provider.receipt).toHaveBeenCalledWith('ticket');
      expect(repo.finish).toHaveBeenCalledWith(
        work,
        status === 'ok'
          ? { status: 'SENT', errorCode: null, completedAt: NOW }
          : expect.objectContaining({
              nextAttemptAt: new Date(NOW.getTime() + PUSH_RECEIPT_DELAY_MS),
            }),
      );
    },
  );
});

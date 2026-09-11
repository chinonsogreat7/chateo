import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../auth/providers/clock';
import { PushProvider } from './expo-push.provider';
import { PushRepository, type LeasedPush } from './push.repository';
import { PushPresenceService } from './push-presence.service';
import {
  PUSH_JOB_MAX_AGE_MS,
  PUSH_MAX_ATTEMPTS,
  PUSH_RECEIPT_DELAY_MS,
} from './push-policy';

@Injectable()
export class PushWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PushWorkerService.name);
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  constructor(
    private readonly repository: PushRepository,
    private readonly provider: PushProvider,
    private readonly presence: PushPresenceService,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) return;
    this.start();
    this.timer = setInterval(() => this.start(), 5000);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
  private enabled(): boolean {
    return this.config.get<boolean>('PUSH_NOTIFICATIONS_ENABLED', false);
  }
  private start(): void {
    if (this.running) return;
    this.running = this.sweepOnce()
      .catch(() =>
        this.logger.warn('Push sweep failed; pending work will retry.'),
      )
      .finally(() => {
        this.running = null;
      });
  }
  async sweepOnce(): Promise<void> {
    if (!this.enabled()) return;
    const jobs = await this.repository.claimDue(this.clock.now());
    // At most five provider requests at once; bounded batch and per-call timeout.
    for (let index = 0; index < jobs.length; index += 5)
      await Promise.all(
        jobs.slice(index, index + 5).map((job) => this.process(job)),
      );
  }
  private async process(job: LeasedPush): Promise<void> {
    const now = this.clock.now();
    try {
      if (job.status === 'RECEIPT') {
        if (
          !job.ticketId ||
          !job.ticketAt ||
          now.getTime() - job.ticketAt.getTime() >= PUSH_JOB_MAX_AGE_MS
        )
          return await this.terminal(job, 'FAILED', 'ReceiptExpired', now);
        const receipt = await this.provider.receipt(job.ticketId);
        if (receipt.status === 'ok')
          return await this.terminal(job, 'SENT', null, now);
        if (
          receipt.status === 'error' &&
          receipt.code === 'DeviceNotRegistered'
        )
          await this.repository.invalidateDevice(job, now);
        if (receipt.status === 'error' && !receipt.retryable)
          return await this.terminal(job, 'FAILED', receipt.code, now);
        // An explicit throttling rejection permits another send. Missing or
        // uncertain receipts only poll the same ticket, avoiding blind resends.
        if (
          receipt.status === 'error' &&
          receipt.code === 'MessageRateExceeded'
        ) {
          if (job.attempts >= PUSH_MAX_ATTEMPTS)
            return await this.terminal(job, 'FAILED', receipt.code, now);
          return await this.repository.finish(job, {
            status: 'PENDING',
            ticketId: null,
            ticketAt: null,
            errorCode: receipt.code,
            nextAttemptAt: new Date(
              now.getTime() +
                Math.min(3600_000, 15000 * 2 ** Math.min(job.attempts, 8)),
            ),
          });
        }
        return await this.repository.finish(job, {
          nextAttemptAt: new Date(now.getTime() + PUSH_RECEIPT_DELAY_MS),
          errorCode: receipt.status === 'error' ? receipt.code : null,
        });
      }
      if (now.getTime() - job.createdAt.getTime() >= PUSH_JOB_MAX_AGE_MS)
        return await this.terminal(job, 'SKIPPED', 'Expired', now);
      if (job.attempts > PUSH_MAX_ATTEMPTS)
        return await this.terminal(job, 'FAILED', 'AttemptsExhausted', now);
      const delivery = await this.repository.eligible(job, now);
      if (!delivery)
        return await this.terminal(job, 'SKIPPED', 'Ineligible', now);
      if (await this.presence.isOnline(delivery.userId, now))
        return await this.terminal(job, 'SKIPPED', 'Online', now);
      // Policy checks and network I/O cannot be atomic, but never knowingly send
      // a job whose lease expired or was replaced while those checks ran.
      if (!(await this.repository.ownsLease(job, this.clock.now()))) return;
      const result = await this.provider.send(delivery, job.id);
      if (result.status === 'accepted')
        return await this.repository.finish(job, {
          status: 'RECEIPT',
          ticketId: result.ticketId,
          ticketAt: now,
          nextAttemptAt: new Date(now.getTime() + PUSH_RECEIPT_DELAY_MS),
          errorCode: null,
        });
      if (result.status === 'error') {
        if (result.code === 'DeviceNotRegistered')
          await this.repository.invalidateDevice(job, now);
        if (!result.retryable || job.attempts >= PUSH_MAX_ATTEMPTS)
          return await this.terminal(job, 'FAILED', result.code, now);
        return await this.retry(job, result.code, now);
      }
      await this.retry(job, 'MalformedResponse', now);
    } catch {
      // Do not log provider payloads, tokens, or message content.
      this.logger.warn(`Push job ${job.id} will retry after a worker error.`);
      try {
        if (job.status === 'RECEIPT')
          await this.repository.finish(job, {
            nextAttemptAt: new Date(now.getTime() + PUSH_RECEIPT_DELAY_MS),
            errorCode: 'WorkerError',
          });
        else if (job.attempts >= PUSH_MAX_ATTEMPTS)
          await this.terminal(job, 'FAILED', 'WorkerError', now);
        else await this.retry(job, 'WorkerError', now);
      } catch {
        /* Lease expiry recovers jobs after a database outage. */
      }
    }
  }
  private retry(job: LeasedPush, code: string, now: Date): Promise<void> {
    return this.repository.finish(job, {
      errorCode: code,
      nextAttemptAt: new Date(
        now.getTime() +
          Math.min(3600_000, 15000 * 2 ** Math.min(job.attempts, 8)),
      ),
    });
  }
  private terminal(
    job: LeasedPush,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    errorCode: string | null,
    now: Date,
  ): Promise<void> {
    if (status === 'FAILED')
      this.logger.warn(`Push job ${job.id} failed (${errorCode}).`);
    return this.repository.finish(job, { status, errorCode, completedAt: now });
  }
}

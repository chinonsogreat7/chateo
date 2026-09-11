import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaClock } from './media-clock';
import { MediaCleanupRepository } from './media-cleanup.repository';
import { MediaStorageProvider } from './media-storage.provider';

const CLOUDINARY_SIGNATURE_VALIDITY_MS = 60 * 60 * 1000;
const MEDIA_CLEANUP_GRACE_MS = 5 * 60 * 1000;
const MEDIA_CLEANUP_INTERVAL_MS = 60 * 1000;
const MEDIA_CLEANUP_BATCH_SIZE = 50;

@Injectable()
export class MediaCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MediaCleanupService.name);
  private timer: NodeJS.Timeout | null = null;
  private runningSweep: Promise<void> | null = null;

  constructor(
    private readonly repository: MediaCleanupRepository,
    private readonly storage: MediaStorageProvider,
    private readonly clock: MediaClock,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.uploadsEnabled()) return;

    this.startSweep();
    this.timer = setInterval(
      () => this.startSweep(),
      MEDIA_CLEANUP_INTERVAL_MS,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.runningSweep;
  }

  async sweepOnce(): Promise<void> {
    if (!this.uploadsEnabled()) return;

    const now = this.clock.now();
    const signatureIssuedBefore = new Date(
      now.getTime() - CLOUDINARY_SIGNATURE_VALIDITY_MS - MEDIA_CLEANUP_GRACE_MS,
    );
    const unused = this.config.get<boolean>(
      'MEDIA_UNUSED_CLEANUP_ENABLED',
      false,
    )
      ? {
          unusedBefore: new Date(
            now.getTime() -
              this.config.get<number>('MEDIA_UNUSED_RETENTION_HOURS', 24) *
                3600_000,
          ),
        }
      : {};
    const candidates = await this.repository.findCandidates({
      signatureIssuedBefore,
      expiredBefore: now,
      limit: MEDIA_CLEANUP_BATCH_SIZE,
      ...unused,
    });

    for (const candidate of candidates) {
      const transition = {
        id: candidate.id,
        signatureIssuedBefore,
        expiredBefore: now,
        now,
        ...unused,
      };

      try {
        if (candidate.status === 'READY') {
          if (!(await this.repository.claimUnusedReady(transition))) continue;
        }
        if (candidate.status === 'PENDING') {
          const claimed = await this.repository.claimExpiredPending(transition);
          if (!claimed) continue;
        }

        if (candidate.resourceType === 'raw') {
          await this.storage.deleteDocument(candidate.cloudinaryPublicId);
        } else if (candidate.resourceType === 'video') {
          await this.storage.deleteAudio(candidate.cloudinaryPublicId);
        } else {
          await this.storage.deleteImage(candidate.cloudinaryPublicId);
        }
        await this.repository.markDeleted(transition);
      } catch (error) {
        this.logger.warn(
          `Media cleanup will retry ${candidate.id} on a future sweep.`,
          error instanceof Error ? error.stack : undefined,
        );
      }
    }
  }

  private startSweep(): void {
    if (this.runningSweep) return;

    const running = this.sweepOnce().catch((error: unknown) => {
      this.logger.warn(
        'Media cleanup sweep failed and will be retried.',
        error instanceof Error ? error.stack : undefined,
      );
    });
    this.runningSweep = running;
    void running.then(() => {
      if (this.runningSweep === running) this.runningSweep = null;
    });
  }

  private uploadsEnabled(): boolean {
    return this.config.get<boolean>('MEDIA_UPLOADS_ENABLED', false);
  }
}

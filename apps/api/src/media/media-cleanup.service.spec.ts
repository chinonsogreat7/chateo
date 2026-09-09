import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaCleanupRepository } from './media-cleanup.repository';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaClock } from './media-clock';
import { MediaStorageProvider } from './media-storage.provider';

const NOW = new Date('2026-09-06T12:00:00.000Z');
const SIGNATURE_SAFE_CUTOFF = new Date('2026-09-06T10:55:00.000Z');

function createService(enabled = true) {
  const repository: jest.Mocked<MediaCleanupRepository> = {
    findCandidates: jest.fn().mockResolvedValue([]),
    claimExpiredPending: jest.fn(),
    markDeleted: jest.fn(),
  };
  const storage: jest.Mocked<MediaStorageProvider> = {
    signImageUpload: jest.fn(),
    signAudioUpload: jest.fn(),
    findImage: jest.fn(),
    findAudio: jest.fn(),
    deleteImage: jest.fn(),
    deleteAudio: jest.fn(),
  };
  const clock: MediaClock = { now: () => new Date(NOW.getTime()) };
  const config = {
    get: jest.fn((key: string, defaultValue: unknown) =>
      key === 'MEDIA_UPLOADS_ENABLED' ? enabled : defaultValue,
    ),
  } as unknown as ConfigService;

  return {
    repository,
    storage,
    service: new MediaCleanupService(repository, storage, clock, config),
  };
}

describe('MediaCleanupService', () => {
  it('claims an expired pending upload before deleting and marking it deleted', async () => {
    const { repository, storage, service } = createService();
    repository.findCandidates.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        cloudinaryPublicId: 'chateo/profile-avatars/media-id',
        resourceType: 'image',
        status: 'PENDING',
      },
    ]);
    repository.claimExpiredPending.mockResolvedValue(true);
    storage.deleteImage.mockResolvedValue();
    repository.markDeleted.mockResolvedValue(true);

    await service.sweepOnce();

    expect(repository.findCandidates).toHaveBeenCalledWith({
      signatureIssuedBefore: SIGNATURE_SAFE_CUTOFF,
      expiredBefore: NOW,
      limit: 50,
    });
    const transition = {
      id: '22222222-2222-4222-8222-222222222222',
      signatureIssuedBefore: SIGNATURE_SAFE_CUTOFF,
      expiredBefore: NOW,
      now: NOW,
    };
    expect(repository.claimExpiredPending).toHaveBeenCalledWith(transition);
    expect(storage.deleteImage).toHaveBeenCalledWith(
      'chateo/profile-avatars/media-id',
    );
    expect(repository.markDeleted).toHaveBeenCalledWith(transition);
  });

  it('cleans up expired pending message-image uploads through the same lifecycle', async () => {
    const { repository, storage, service } = createService();
    repository.findCandidates.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        cloudinaryPublicId: 'chateo/message-images/media-id',
        resourceType: 'image',
        status: 'PENDING',
      },
    ]);
    repository.claimExpiredPending.mockResolvedValue(true);
    storage.deleteImage.mockResolvedValue();
    repository.markDeleted.mockResolvedValue(true);

    await service.sweepOnce();

    expect(storage.deleteImage).toHaveBeenCalledWith(
      'chateo/message-images/media-id',
    );
    expect(repository.markDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '33333333-3333-4333-8333-333333333333',
      }),
    );
  });

  it('cleans up chat audio through the Cloudinary video destroy path', async () => {
    const { repository, storage, service } = createService();
    repository.findCandidates.mockResolvedValue([
      {
        id: '44444444-4444-4444-8444-444444444444',
        cloudinaryPublicId: 'chateo/message-audio/media-id',
        resourceType: 'video',
        status: 'FAILED',
      },
    ]);
    storage.deleteAudio.mockResolvedValue();
    repository.markDeleted.mockResolvedValue(true);

    await service.sweepOnce();

    expect(storage.deleteAudio).toHaveBeenCalledWith(
      'chateo/message-audio/media-id',
    );
    expect(storage.deleteImage).not.toHaveBeenCalled();
    expect(repository.markDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        id: '44444444-4444-4444-8444-444444444444',
      }),
    );
  });

  it('does not delete when another transition wins the pending claim', async () => {
    const { repository, storage, service } = createService();
    repository.findCandidates.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        cloudinaryPublicId: 'chateo/profile-avatars/media-id',
        resourceType: 'image',
        status: 'PENDING',
      },
    ]);
    repository.claimExpiredPending.mockResolvedValue(false);

    await service.sweepOnce();

    expect(storage.deleteImage).not.toHaveBeenCalled();
    expect(repository.markDeleted).not.toHaveBeenCalled();
  });

  it('leaves a failed row retryable when provider deletion fails', async () => {
    const warning = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const { repository, storage, service } = createService();
    repository.findCandidates.mockResolvedValue([
      {
        id: '22222222-2222-4222-8222-222222222222',
        cloudinaryPublicId: 'chateo/profile-avatars/media-id',
        resourceType: 'image',
        status: 'FAILED',
      },
    ]);
    storage.deleteImage.mockRejectedValueOnce(
      new Error('provider unavailable'),
    );

    await service.sweepOnce();

    expect(repository.markDeleted).not.toHaveBeenCalled();

    storage.deleteImage.mockResolvedValueOnce();
    repository.markDeleted.mockResolvedValueOnce(true);
    await service.sweepOnce();

    expect(storage.deleteImage).toHaveBeenCalledTimes(2);
    expect(repository.markDeleted).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  it('does not start a timer or query storage when uploads are disabled', async () => {
    jest.useFakeTimers();
    try {
      const { repository, service } = createService(false);

      service.onModuleInit();
      jest.advanceTimersByTime(5 * 60 * 1000);
      await service.onModuleDestroy();

      expect(jest.getTimerCount()).toBe(0);
      expect(repository.findCandidates).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears its unrefed interval during module shutdown', async () => {
    jest.useFakeTimers();
    try {
      const { repository, service } = createService();

      service.onModuleInit();
      await service.onModuleDestroy();

      expect(repository.findCandidates).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

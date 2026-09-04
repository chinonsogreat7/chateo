import { HttpStatus } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationEventsPublisher } from '../conversations/conversation-events.publisher';
import { ConversationSettingsRepository } from './conversation-settings.repository';
import { ConversationSettingsService } from './conversation-settings.service';
import { ConversationMuteDuration } from './dto/mute-conversation.dto';

const USER_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const NORMALIZED_USER_ID = USER_ID.toLowerCase();
const CONVERSATION_ID = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const NORMALIZED_CONVERSATION_ID = CONVERSATION_ID.toLowerCase();
const NOW = new Date('2026-09-03T17:00:00.000Z');
const ARCHIVED_AT = new Date('2026-09-02T10:00:00.000Z');
const MUTED_AT = new Date('2026-09-03T07:00:00.000Z');
const PINNED_AT = new Date('2026-09-03T08:00:00.000Z');
const FAVORITED_AT = new Date('2026-09-03T09:00:00.000Z');

function createService() {
  const repository: jest.Mocked<ConversationSettingsRepository> = {
    updateForMember: jest.fn(),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  const eventsPublisher: jest.Mocked<ConversationEventsPublisher> = {
    publishCreated: jest.fn().mockResolvedValue(undefined),
    publishSettingsUpdated: jest.fn().mockResolvedValue(undefined),
    publishGroupChanged: jest.fn().mockResolvedValue(undefined),
  };
  return {
    repository,
    clock,
    eventsPublisher,
    service: new ConversationSettingsService(
      repository,
      clock,
      eventsPublisher,
    ),
  };
}

async function expectApiError(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected ${code}, but the operation resolved.`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiException);
  const exception = error as ApiException;
  expect(exception.getStatus()).toBe(status);
  expect(exception.getResponse()).toMatchObject({ code });
}

describe('ConversationSettingsService', () => {
  it('updates only requested settings using the injected clock', async () => {
    const { repository, clock, eventsPublisher, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: ARCHIVED_AT,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: PINNED_AT,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });

    await expect(
      service.update(USER_ID, CONVERSATION_ID, {
        archived: true,
        muted: false,
      }),
    ).resolves.toEqual({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archived: true,
      muted: false,
      pinned: true,
      favorited: true,
      archivedAt: ARCHIVED_AT.toISOString(),
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: PINNED_AT.toISOString(),
      favoritedAt: FAVORITED_AT.toISOString(),
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    expect(repository.updateForMember).toHaveBeenCalledWith({
      conversationId: NORMALIZED_CONVERSATION_ID,
      userId: NORMALIZED_USER_ID,
      archived: true,
      muted: false,
      mutedUntil: undefined,
      pinned: undefined,
      now: NOW,
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(eventsPublisher.publishSettingsUpdated).toHaveBeenCalledWith({
      conversationId: NORMALIZED_CONVERSATION_ID,
      userId: NORMALIZED_USER_ID,
      archivedAt: ARCHIVED_AT,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: PINNED_AT,
      favoritedAt: FAVORITED_AT,
      occurredAt: NOW,
    });
  });

  it('rejects an empty update before reading the clock or repository', async () => {
    const { repository, clock, service } = createService();

    await expectApiError(
      service.update(USER_ID, CONVERSATION_ID, {}),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_SETTINGS_UPDATE_EMPTY',
    );
    expect(repository.updateForMember).not.toHaveBeenCalled();
    expect(clock.now).not.toHaveBeenCalled();
  });

  it('does not publish a realtime event for an idempotent update', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: false,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: ARCHIVED_AT,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: PINNED_AT,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });

    await expect(
      service.update(USER_ID, CONVERSATION_ID, { archived: true }),
    ).resolves.toMatchObject({ archived: true });
    expect(eventsPublisher.publishSettingsUpdated).not.toHaveBeenCalled();
  });

  it.each([
    ['archives', true, ARCHIVED_AT],
    ['unarchives', false, null],
  ] as const)(
    '%s a conversation through the dedicated settings action',
    async (_operation, archived, archivedAt) => {
      const { repository, service } = createService();
      repository.updateForMember.mockResolvedValue({
        status: 'updated',
        changed: true,
        settings: {
          conversationId: NORMALIZED_CONVERSATION_ID,
          archivedAt,
          mutedAt: MUTED_AT,
          mutedUntil: null,
          pinnedAt: PINNED_AT,
          favoritedAt: FAVORITED_AT,
          clearedAt: null,
          clearedThroughMessageId: null,
        },
      });

      await expect(
        service.setArchived(USER_ID, CONVERSATION_ID, archived),
      ).resolves.toMatchObject({
        archived,
        archivedAt: archivedAt?.toISOString() ?? null,
        muted: true,
        pinned: true,
        favorited: true,
      });
      expect(repository.updateForMember).toHaveBeenCalledWith({
        conversationId: NORMALIZED_CONVERSATION_ID,
        userId: NORMALIZED_USER_ID,
        archived,
        now: NOW,
      });
    },
  );

  it('returns an indistinguishable not-found response for non-members', async () => {
    const { repository, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'conversation-not-found',
    });

    await expectApiError(
      service.update(USER_ID, CONVERSATION_ID, { pinned: true }),
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
    );
  });

  it.each([
    [ConversationMuteDuration.EightHours, 8 * 60 * 60 * 1_000],
    [ConversationMuteDuration.TwentyFourHours, 24 * 60 * 60 * 1_000],
    [ConversationMuteDuration.SevenDays, 7 * 24 * 60 * 60 * 1_000],
  ] as const)(
    'mutes for %s from the server clock',
    async (duration, milliseconds) => {
      const { repository, service } = createService();
      const expectedUntil = new Date(NOW.getTime() + milliseconds);
      repository.updateForMember.mockResolvedValue({
        status: 'updated',
        changed: true,
        settings: {
          conversationId: NORMALIZED_CONVERSATION_ID,
          archivedAt: null,
          mutedAt: NOW,
          mutedUntil: expectedUntil,
          pinnedAt: null,
          favoritedAt: null,
          clearedAt: null,
          clearedThroughMessageId: null,
        },
      });

      await expect(
        service.mute(USER_ID, CONVERSATION_ID, duration),
      ).resolves.toMatchObject({
        muted: true,
        mutedAt: NOW.toISOString(),
        mutedUntil: expectedUntil.toISOString(),
      });
      expect(repository.updateForMember).toHaveBeenCalledWith({
        conversationId: NORMALIZED_CONVERSATION_ID,
        userId: NORMALIZED_USER_ID,
        muted: true,
        mutedUntil: expectedUntil,
        now: NOW,
      });
    },
  );

  it('uses a null expiry for an indefinite mute and preserves legacy PATCH semantics', async () => {
    const { repository, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: null,
        mutedAt: MUTED_AT,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });

    await service.mute(
      USER_ID,
      CONVERSATION_ID,
      ConversationMuteDuration.Always,
    );
    expect(repository.updateForMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ muted: true, mutedUntil: null }),
    );

    await service.update(USER_ID, CONVERSATION_ID, { muted: true });
    expect(repository.updateForMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ muted: true, mutedUntil: null }),
    );
  });

  it('unmutes a conversation and removes it from favorites', async () => {
    const { repository, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });

    await expect(
      service.unmute(USER_ID, CONVERSATION_ID),
    ).resolves.toMatchObject({ muted: false });
    expect(repository.updateForMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ muted: false }),
    );

    await expect(
      service.setFavorite(USER_ID, CONVERSATION_ID, false),
    ).resolves.toMatchObject({ favorited: false });
    expect(repository.updateForMember).toHaveBeenLastCalledWith(
      expect.objectContaining({ favorited: false }),
    );
  });

  it('adds a conversation to favorites', async () => {
    const { repository, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });

    await expect(
      service.setFavorite(USER_ID, CONVERSATION_ID, true),
    ).resolves.toMatchObject({
      favorited: true,
      favoritedAt: FAVORITED_AT.toISOString(),
    });
    expect(repository.updateForMember).toHaveBeenCalledWith({
      conversationId: NORMALIZED_CONVERSATION_ID,
      userId: NORMALIZED_USER_ID,
      favorited: true,
      now: NOW,
    });
  });

  it('does not wait for realtime delivery after the settings commit', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });
    eventsPublisher.publishSettingsUpdated.mockReturnValue(
      new Promise<void>(() => undefined),
    );

    await expect(
      service.setFavorite(USER_ID, CONVERSATION_ID, true),
    ).resolves.toMatchObject({ favorited: true });
    expect(eventsPublisher.publishSettingsUpdated).toHaveBeenCalledTimes(1);
  });

  it('contains asynchronous realtime publication failures', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });
    eventsPublisher.publishSettingsUpdated.mockRejectedValue(
      new Error('socket transport unavailable'),
    );
    const warn = jest
      .spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    await expect(
      service.setFavorite(USER_ID, CONVERSATION_ID, true),
    ).resolves.toMatchObject({ favorited: true });
    await Promise.resolve();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('reports an expired finite mute as inactive', async () => {
    const { repository, service } = createService();
    repository.updateForMember.mockResolvedValue({
      status: 'updated',
      changed: false,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: null,
        mutedAt: MUTED_AT,
        mutedUntil: new Date(NOW.getTime() - 1),
        pinnedAt: null,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });

    await expect(
      service.setFavorite(USER_ID, CONVERSATION_ID, true),
    ).resolves.toMatchObject({ muted: false, favorited: true });
  });
});

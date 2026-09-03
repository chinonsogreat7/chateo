import { HttpStatus } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationEventsPublisher } from '../conversations/conversation-events.publisher';
import { ConversationSettingsRepository } from './conversation-settings.repository';
import { ConversationSettingsService } from './conversation-settings.service';

const USER_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const NORMALIZED_USER_ID = USER_ID.toLowerCase();
const CONVERSATION_ID = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const NORMALIZED_CONVERSATION_ID = CONVERSATION_ID.toLowerCase();
const NOW = new Date('2026-09-03T17:00:00.000Z');
const ARCHIVED_AT = new Date('2026-09-02T10:00:00.000Z');
const PINNED_AT = new Date('2026-09-03T08:00:00.000Z');

function createService() {
  const repository: jest.Mocked<ConversationSettingsRepository> = {
    updateForMember: jest.fn(),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  const eventsPublisher: jest.Mocked<ConversationEventsPublisher> = {
    publishCreated: jest.fn().mockResolvedValue(undefined),
    publishSettingsUpdated: jest.fn().mockResolvedValue(undefined),
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
        pinnedAt: PINNED_AT,
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
      archivedAt: ARCHIVED_AT.toISOString(),
      mutedAt: null,
      pinnedAt: PINNED_AT.toISOString(),
    });
    expect(repository.updateForMember).toHaveBeenCalledWith({
      conversationId: NORMALIZED_CONVERSATION_ID,
      userId: NORMALIZED_USER_ID,
      archived: true,
      muted: false,
      pinned: undefined,
      now: NOW,
    });
    expect(clock.now).toHaveBeenCalledTimes(1);
    expect(eventsPublisher.publishSettingsUpdated).toHaveBeenCalledWith({
      conversationId: NORMALIZED_CONVERSATION_ID,
      userId: NORMALIZED_USER_ID,
      archivedAt: ARCHIVED_AT,
      mutedAt: null,
      pinnedAt: PINNED_AT,
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
        pinnedAt: PINNED_AT,
      },
    });

    await expect(
      service.update(USER_ID, CONVERSATION_ID, { archived: true }),
    ).resolves.toMatchObject({ archived: true });
    expect(eventsPublisher.publishSettingsUpdated).not.toHaveBeenCalled();
  });

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
});

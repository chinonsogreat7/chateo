import { HttpStatus } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsService } from './conversations.service';
import type { ConversationRecord } from './conversations.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-12T12:00:00.000Z');

function conversation(
  overrides: Partial<ConversationRecord> = {},
): ConversationRecord {
  return {
    id: CONVERSATION_ID,
    type: 'DIRECT',
    otherParticipant: {
      id: PARTICIPANT_ID,
      displayName: 'Ada Okafor',
      avatarUrl: null,
    },
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createService() {
  const repository: jest.Mocked<ConversationsRepository> = {
    createOrGetDirect: jest.fn(),
    listForUser: jest.fn(),
    findForUser: jest.fn(),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  return {
    repository,
    service: new ConversationsService(repository, clock),
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

describe('ConversationsService', () => {
  it('rejects starting a direct conversation with yourself', async () => {
    const { repository, service } = createService();

    await expectApiError(
      service.createDirect(USER_ID, USER_ID),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_SELF_NOT_ALLOWED',
    );

    expect(repository.createOrGetDirect).not.toHaveBeenCalled();
  });

  it('normalizes UUID casing before comparing or persisting a pair', async () => {
    const { repository, service } = createService();
    const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const participantId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    repository.createOrGetDirect.mockResolvedValue({
      status: 'created',
      conversation: conversation(),
    });

    await service.createDirect(
      userId.toUpperCase(),
      participantId.toUpperCase(),
    );

    expect(repository.createOrGetDirect).toHaveBeenCalledWith(
      userId,
      participantId,
      NOW,
    );

    await expectApiError(
      service.createDirect(userId, userId.toUpperCase()),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_SELF_NOT_ALLOWED',
    );
  });

  it('returns USER_NOT_FOUND when the participant is missing', async () => {
    const { repository, service } = createService();
    repository.createOrGetDirect.mockResolvedValue({
      status: 'participant-not-found',
    });

    await expectApiError(
      service.createDirect(USER_ID, PARTICIPANT_ID),
      HttpStatus.NOT_FOUND,
      'USER_NOT_FOUND',
    );

    expect(repository.createOrGetDirect).toHaveBeenCalledWith(
      USER_ID,
      PARTICIPANT_ID,
      NOW,
    );
  });

  it('maps a direct conversation without exposing a phone number', async () => {
    const { repository, service } = createService();
    repository.createOrGetDirect.mockResolvedValue({
      status: 'created',
      conversation: conversation(),
    });

    const result = await service.createDirect(USER_ID, PARTICIPANT_ID);

    expect(result).toEqual({
      id: CONVERSATION_ID,
      type: 'direct',
      otherParticipant: {
        id: PARTICIPANT_ID,
        displayName: 'Ada Okafor',
        avatarUrl: null,
      },
      latestMessage: null,
      unreadCount: 0,
      lastActivityAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(result.otherParticipant).not.toHaveProperty('phoneNumber');
  });

  it('returns the same not-found domain error for inaccessible conversations', async () => {
    const { repository, service } = createService();
    repository.findForUser.mockResolvedValue(null);

    await expectApiError(
      service.get(USER_ID, CONVERSATION_ID),
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
    );

    expect(repository.findForUser).toHaveBeenCalledWith(
      CONVERSATION_ID,
      USER_ID,
    );
  });

  it('returns opaque cursor pagination and accepts its next cursor', async () => {
    const { repository, service } = createService();
    const first = conversation({
      id: '33333333-3333-4333-8333-333333333335',
      lastActivityAt: new Date('2026-08-12T12:03:00.000Z'),
    });
    const second = conversation({
      id: '33333333-3333-4333-8333-333333333334',
      lastActivityAt: new Date('2026-08-12T12:02:00.000Z'),
    });
    const lookahead = conversation({
      id: '33333333-3333-4333-8333-333333333333',
      lastActivityAt: new Date('2026-08-12T12:01:00.000Z'),
    });
    repository.listForUser
      .mockResolvedValueOnce([first, second, lookahead])
      .mockResolvedValueOnce([]);

    const page = await service.list(USER_ID, 2);
    expect(page.items.map((item) => item.id)).toEqual([first.id, second.id]);
    expect(page.pageInfo).toEqual({
      nextCursor: expect.any(String),
      hasNextPage: true,
    });
    expect(repository.listForUser).toHaveBeenNthCalledWith(1, USER_ID, null, 3);

    await service.list(USER_ID, 2, page.pageInfo.nextCursor ?? undefined);
    expect(repository.listForUser).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      { id: second.id, lastActivityAt: second.lastActivityAt },
      3,
    );
  });

  it.each(['', 'not-a-valid-cursor'])(
    'rejects invalid cursor %j with a domain error before querying',
    async (cursor) => {
      const { repository, service } = createService();

      await expectApiError(
        service.list(USER_ID, 20, cursor),
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_CURSOR_INVALID',
      );

      expect(repository.listForUser).not.toHaveBeenCalled();
    },
  );
});

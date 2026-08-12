import { HttpStatus, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { MessageEventsPublisher } from './message-events.publisher';
import { MessagesRepository } from './messages.repository';
import { MessagesService } from './messages.service';
import type { MessageRecord } from './messages.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const REPLY_MESSAGE_ID = '44444444-4444-4444-8444-444444444445';
const CLIENT_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-08-12T16:00:00.000Z');

function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    senderId: USER_ID,
    replyToMessageId: null,
    replyTo: null,
    kind: 'TEXT',
    text: 'Hello!',
    createdAt: NOW,
    participantIds: [USER_ID, OTHER_USER_ID],
    ...overrides,
  };
}

function createService() {
  const repository: jest.Mocked<MessagesRepository> = {
    sendText: jest.fn(),
    listForMember: jest.fn(),
    markRead: jest.fn(),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  const eventsPublisher: jest.Mocked<MessageEventsPublisher> = {
    publishCreated: jest.fn().mockResolvedValue(undefined),
  };
  return {
    repository,
    eventsPublisher,
    service: new MessagesService(repository, clock, eventsPublisher),
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

describe('MessagesService', () => {
  it('returns a newly created text message and publishes it once', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.sendText.mockResolvedValue({
      status: 'created',
      message: message(),
    });

    await expect(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: '  Hello!  ',
      }),
    ).resolves.toEqual({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      senderId: USER_ID,
      replyToMessageId: null,
      replyTo: null,
      kind: 'text',
      text: 'Hello!',
      createdAt: NOW.toISOString(),
    });
    expect(repository.sendText).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      senderId: USER_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      replyToMessageId: null,
      text: 'Hello!',
      now: NOW,
    });
    expect(eventsPublisher.publishCreated).toHaveBeenCalledWith(message());
  });

  it('normalizes a reply target and returns its shallow projection', async () => {
    const { repository, service } = createService();
    const uppercaseReplyId = REPLY_MESSAGE_ID.toUpperCase();
    repository.sendText.mockResolvedValue({
      status: 'created',
      message: message({
        replyToMessageId: REPLY_MESSAGE_ID,
        replyTo: {
          id: REPLY_MESSAGE_ID,
          senderId: OTHER_USER_ID,
          kind: 'TEXT',
          preview: 'Earlier message',
        },
      }),
    });

    await expect(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        replyToMessageId: uppercaseReplyId,
        text: 'Reply',
      }),
    ).resolves.toMatchObject({
      replyToMessageId: REPLY_MESSAGE_ID,
      replyTo: {
        id: REPLY_MESSAGE_ID,
        senderId: OTHER_USER_ID,
        kind: 'text',
        preview: 'Earlier message',
      },
    });
    expect(repository.sendText).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: REPLY_MESSAGE_ID }),
    );
  });

  it('returns an idempotent replay without publishing a duplicate event', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.sendText.mockResolvedValue({
      status: 'existing',
      message: message(),
    });

    await expect(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Hello!',
      }),
    ).resolves.toMatchObject({ id: MESSAGE_ID });
    expect(eventsPublisher.publishCreated).not.toHaveBeenCalled();
  });

  it('keeps the committed 200 response when realtime publishing fails', async () => {
    const { repository, eventsPublisher, service } = createService();
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.sendText.mockResolvedValue({
      status: 'created',
      message: message(),
    });
    eventsPublisher.publishCreated.mockRejectedValue(
      new Error('socket unavailable'),
    );

    await expect(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Hello!',
      }),
    ).resolves.toMatchObject({ id: MESSAGE_ID });
    expect(logSpy).toHaveBeenCalledWith(
      `Failed to publish message.created for ${MESSAGE_ID}`,
      expect.any(String),
    );
    logSpy.mockRestore();
  });

  it('rejects reuse of an idempotency key with different data', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.sendText.mockResolvedValue({
      status: 'idempotency-conflict',
    });

    await expectApiError(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Different text',
      }),
      HttpStatus.CONFLICT,
      'MESSAGE_IDEMPOTENCY_CONFLICT',
    );
    expect(eventsPublisher.publishCreated).not.toHaveBeenCalled();
  });

  it('uses a privacy-safe not-found error for an invalid reply target', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.sendText.mockResolvedValue({
      status: 'reply-message-not-found',
    });

    await expectApiError(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        replyToMessageId: REPLY_MESSAGE_ID,
        text: 'Reply',
      }),
      HttpStatus.NOT_FOUND,
      'MESSAGE_NOT_FOUND',
    );
    expect(eventsPublisher.publishCreated).not.toHaveBeenCalled();
  });

  it('uses the same not-found error for inaccessible send, history, and read operations', async () => {
    const { repository, service } = createService();
    repository.sendText.mockResolvedValue({
      status: 'conversation-not-found',
    });
    repository.listForMember.mockResolvedValue({
      status: 'conversation-not-found',
    });
    repository.markRead.mockResolvedValue({
      status: 'conversation-not-found',
    });

    await expectApiError(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Hello!',
      }),
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
    );
    await expectApiError(
      service.list(USER_ID, CONVERSATION_ID, 50),
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
    );
    await expectApiError(
      service.markRead(USER_ID, CONVERSATION_ID),
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
    );
  });

  it('returns opaque newest-first pagination and accepts its next cursor', async () => {
    const { repository, service } = createService();
    const newest = message({
      id: '44444444-4444-4444-8444-444444444446',
      createdAt: new Date('2026-08-12T16:02:00.000Z'),
    });
    const second = message({
      id: '44444444-4444-4444-8444-444444444445',
      createdAt: new Date('2026-08-12T16:01:00.000Z'),
    });
    const lookahead = message();
    repository.listForMember
      .mockResolvedValueOnce({
        status: 'found',
        messages: [newest, second, lookahead],
      })
      .mockResolvedValueOnce({ status: 'found', messages: [] });

    const page = await service.list(USER_ID, CONVERSATION_ID, 2);
    expect(page.items.map((item) => item.id)).toEqual([newest.id, second.id]);
    expect(page.pageInfo).toEqual({
      nextCursor: expect.any(String),
      hasNextPage: true,
    });
    expect(repository.listForMember).toHaveBeenNthCalledWith(
      1,
      CONVERSATION_ID,
      USER_ID,
      null,
      3,
    );

    await service.list(
      USER_ID,
      CONVERSATION_ID,
      2,
      page.pageInfo.nextCursor ?? undefined,
    );
    expect(repository.listForMember).toHaveBeenNthCalledWith(
      2,
      CONVERSATION_ID,
      USER_ID,
      { id: second.id, createdAt: second.createdAt },
      3,
    );
  });

  it.each(['', 'not-a-valid-cursor'])(
    'rejects invalid cursor %j before querying',
    async (cursor) => {
      const { repository, service } = createService();

      await expectApiError(
        service.list(USER_ID, CONVERSATION_ID, 50, cursor),
        HttpStatus.BAD_REQUEST,
        'MESSAGE_CURSOR_INVALID',
      );
      expect(repository.listForMember).not.toHaveBeenCalled();
    },
  );

  it('maps persisted read state', async () => {
    const { repository, service } = createService();
    repository.markRead.mockResolvedValue({
      status: 'updated',
      state: {
        conversationId: CONVERSATION_ID,
        lastReadAt: NOW,
        unreadCount: 0,
      },
    });

    await expect(service.markRead(USER_ID, CONVERSATION_ID)).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      lastReadAt: NOW.toISOString(),
      unreadCount: 0,
    });
    expect(repository.markRead).toHaveBeenCalledWith(
      CONVERSATION_ID,
      USER_ID,
      NOW,
    );
  });
});

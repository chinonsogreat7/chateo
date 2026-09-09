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
const CLIENT_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const ATTACHMENT_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-08-12T16:00:00.000Z');

function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    senderId: USER_ID,
    kind: 'TEXT',
    text: 'Hello!',
    attachments: [],
    createdAt: NOW,
    participantIds: [USER_ID, OTHER_USER_ID],
    ...overrides,
  };
}

function createService() {
  const repository: jest.Mocked<MessagesRepository> = {
    send: jest.fn(),
    sendText: jest.fn(),
    listForMember: jest.fn(),
    markRead: jest.fn(),
    clearForMember: jest.fn(),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  const eventsPublisher: jest.Mocked<MessageEventsPublisher> = {
    publishCreated: jest.fn().mockResolvedValue(undefined),
    publishHistoryCleared: jest.fn().mockResolvedValue(undefined),
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
    repository.send.mockResolvedValue({
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
      kind: 'text',
      text: 'Hello!',
      attachments: [],
      createdAt: NOW.toISOString(),
    });
    expect(repository.send).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      senderId: USER_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      text: 'Hello!',
      attachmentMediaIds: [],
      now: NOW,
    });
    expect(eventsPublisher.publishCreated).toHaveBeenCalledWith(message());
  });

  it('returns an idempotent replay without publishing a duplicate event', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.send.mockResolvedValue({
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

  it('returns and publishes an image message with ordered attachment metadata', async () => {
    const { repository, eventsPublisher, service } = createService();
    const imageMessage = message({
      kind: 'IMAGE',
      text: null,
      attachments: [
        {
          mediaId: ATTACHMENT_ID,
          type: 'image',
          contentType: 'image/jpeg',
          sizeBytes: 245000,
          width: 640,
          height: 480,
          url: 'https://res.cloudinary.com/demo/image/upload/photo.jpg',
        },
      ],
    });
    repository.send.mockResolvedValue({
      status: 'created',
      message: imageMessage,
    });

    await expect(
      service.send(USER_ID.toUpperCase(), CONVERSATION_ID.toUpperCase(), {
        clientMessageId: CLIENT_MESSAGE_ID.toUpperCase(),
        attachmentMediaIds: [ATTACHMENT_ID.toUpperCase()],
      }),
    ).resolves.toEqual({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      senderId: USER_ID,
      kind: 'image',
      text: null,
      attachments: imageMessage.attachments,
      createdAt: NOW.toISOString(),
    });
    expect(repository.send).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      senderId: USER_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      text: null,
      attachmentMediaIds: [ATTACHMENT_ID],
      now: NOW,
    });
    expect(eventsPublisher.publishCreated).toHaveBeenCalledWith(imageMessage);
  });

  it('returns and publishes an audio message with recording metadata', async () => {
    const { repository, eventsPublisher, service } = createService();
    const audioMessage = message({
      kind: 'AUDIO',
      text: 'Voice note',
      attachments: [
        {
          mediaId: ATTACHMENT_ID,
          type: 'audio',
          contentType: 'audio/m4a',
          sizeBytes: 512000,
          durationMs: 32000,
          url: 'https://res.cloudinary.com/demo/video/upload/voice.m4a',
        },
      ],
    });
    repository.send.mockResolvedValue({
      status: 'created',
      message: audioMessage,
    });

    await expect(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: '  Voice note  ',
        attachmentMediaIds: [ATTACHMENT_ID],
      }),
    ).resolves.toEqual({
      id: MESSAGE_ID,
      conversationId: CONVERSATION_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      senderId: USER_ID,
      kind: 'audio',
      text: 'Voice note',
      attachments: audioMessage.attachments,
      createdAt: NOW.toISOString(),
    });
    expect(eventsPublisher.publishCreated).toHaveBeenCalledWith(audioMessage);
  });

  it('keeps the committed 200 response when realtime publishing fails', async () => {
    const { repository, eventsPublisher, service } = createService();
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.send.mockResolvedValue({
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
    await Promise.resolve();
    expect(logSpy).toHaveBeenCalledWith(
      `Failed to publish message.created for ${MESSAGE_ID}`,
      expect.any(String),
    );
    logSpy.mockRestore();
  });

  it('does not wait for realtime publication before returning a committed message', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.send.mockResolvedValue({
      status: 'created',
      message: message(),
    });
    let finishPublishing: (() => void) | undefined;
    eventsPublisher.publishCreated.mockReturnValue(
      new Promise<void>((resolve) => {
        finishPublishing = resolve;
      }),
    );

    await expect(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Hello!',
      }),
    ).resolves.toMatchObject({ id: MESSAGE_ID });

    expect(eventsPublisher.publishCreated).toHaveBeenCalledTimes(1);
    finishPublishing?.();
  });

  it('contains a synchronous realtime publisher failure', async () => {
    const { repository, eventsPublisher, service } = createService();
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.send.mockResolvedValue({
      status: 'created',
      message: message(),
    });
    eventsPublisher.publishCreated.mockImplementation(() => {
      throw new Error('publisher initialization failed');
    });

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
    repository.send.mockResolvedValue({
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

  it('returns one generic conflict when an attachment cannot be claimed', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.send.mockResolvedValue({ status: 'attachment-unavailable' });

    await expectApiError(
      service.send(USER_ID, CONVERSATION_ID, {
        clientMessageId: CLIENT_MESSAGE_ID,
        attachmentMediaIds: [ATTACHMENT_ID],
      }),
      HttpStatus.CONFLICT,
      'MESSAGE_ATTACHMENT_UNAVAILABLE',
    );
    expect(eventsPublisher.publishCreated).not.toHaveBeenCalled();
  });

  it('uses the same not-found error for inaccessible send, history, read, and clear operations', async () => {
    const { repository, service } = createService();
    repository.send.mockResolvedValue({
      status: 'conversation-not-found',
    });
    repository.listForMember.mockResolvedValue({
      status: 'conversation-not-found',
    });
    repository.markRead.mockResolvedValue({
      status: 'conversation-not-found',
    });
    repository.clearForMember.mockResolvedValue({
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
    await expectApiError(
      service.clear(USER_ID, CONVERSATION_ID),
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

  it('clears only the requesting member history through the persisted boundary', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.clearForMember.mockResolvedValue({
      status: 'cleared',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      changed: true,
      clearedAt: NOW,
      clearedThroughMessageId: MESSAGE_ID,
      occurredAt: NOW,
    });

    await expect(service.clear(USER_ID, CONVERSATION_ID)).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      changed: true,
      clearedAt: NOW.toISOString(),
      clearedThroughMessageId: MESSAGE_ID,
    });
    expect(repository.clearForMember).toHaveBeenCalledWith(
      CONVERSATION_ID,
      USER_ID,
      NOW,
    );
    expect(eventsPublisher.publishHistoryCleared).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      changed: true,
      clearedAt: NOW,
      clearedThroughMessageId: MESSAGE_ID,
      occurredAt: NOW,
    });
  });
});

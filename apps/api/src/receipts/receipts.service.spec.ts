import { HttpStatus, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ReceiptEventsPublisher } from './receipt-events.publisher';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsService } from './receipts.service';
import type { ReceiptUpdateRecord } from './receipts.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-08-12T21:00:00.000Z');

function receipt(
  overrides: Partial<ReceiptUpdateRecord> = {},
): ReceiptUpdateRecord {
  return {
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    status: 'DELIVERED',
    throughMessageId: MESSAGE_ID,
    at: NOW,
    version: 1,
    delivered: { messageId: MESSAGE_ID, at: NOW },
    read: null,
    unreadCount: 2,
    participantIds: [USER_ID, OTHER_USER_ID],
    ...overrides,
  };
}

function createService() {
  const repository: jest.Mocked<ReceiptsRepository> = {
    markThrough: jest.fn(),
    listForMember: jest.fn(),
  };
  const publisher: jest.Mocked<ReceiptEventsPublisher> = {
    publishUpdated: jest.fn().mockResolvedValue(undefined),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  return {
    repository,
    publisher,
    service: new ReceiptsService(repository, clock, publisher),
  };
}

async function expectNotFound(promise: Promise<unknown>): Promise<void> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(ApiException);
  expect((error as ApiException).getStatus()).toBe(HttpStatus.NOT_FOUND);
  expect((error as ApiException).getResponse()).toMatchObject({
    code: 'CONVERSATION_NOT_FOUND',
  });
}

describe('ReceiptsService', () => {
  it('publishes and maps a newly changed delivery frontier', async () => {
    const { repository, publisher, service } = createService();
    repository.markThrough.mockResolvedValue({
      status: 'updated',
      changed: true,
      receipt: receipt(),
    });

    await expect(
      service.markDelivered(USER_ID, CONVERSATION_ID, MESSAGE_ID),
    ).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      status: 'delivered',
      throughMessageId: MESSAGE_ID,
      at: NOW.toISOString(),
      changed: true,
      unreadCount: 2,
      version: 1,
      delivered: { messageId: MESSAGE_ID, at: NOW.toISOString() },
      read: null,
    });
    expect(repository.markThrough).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      throughMessageId: MESSAGE_ID,
      status: 'DELIVERED',
      now: NOW,
    });
    expect(publisher.publishUpdated).toHaveBeenCalledWith(receipt());
  });

  it('does not publish an idempotent or older frontier replay', async () => {
    const { repository, publisher, service } = createService();
    repository.markThrough.mockResolvedValue({
      status: 'updated',
      changed: false,
      receipt: receipt(),
    });

    await expect(
      service.markDelivered(USER_ID, CONVERSATION_ID, MESSAGE_ID),
    ).resolves.toMatchObject({ changed: false });
    expect(publisher.publishUpdated).not.toHaveBeenCalled();
  });

  it('maps read state and the reconciled unread count', async () => {
    const { repository, service } = createService();
    repository.markThrough.mockResolvedValue({
      status: 'updated',
      changed: true,
      receipt: receipt({ status: 'READ', unreadCount: 0 }),
    });

    await expect(
      service.markRead(USER_ID, CONVERSATION_ID, MESSAGE_ID),
    ).resolves.toMatchObject({ status: 'read', unreadCount: 0 });
    expect(repository.markThrough).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'READ' }),
    );
  });

  it('returns the same not-found response for inaccessible boundaries and lists', async () => {
    const { repository, service } = createService();
    repository.markThrough.mockResolvedValue({
      status: 'conversation-not-found',
    });
    repository.listForMember.mockResolvedValue({
      status: 'conversation-not-found',
    });

    await expectNotFound(
      service.markRead(USER_ID, CONVERSATION_ID, MESSAGE_ID),
    );
    await expectNotFound(service.list(USER_ID, CONVERSATION_ID));
  });

  it('returns receipt frontiers without internal routing metadata or PII', async () => {
    const { repository, service } = createService();
    repository.listForMember.mockResolvedValue({
      status: 'found',
      conversationId: CONVERSATION_ID,
      frontiers: [
        {
          userId: OTHER_USER_ID,
          version: 2,
          delivered: { messageId: MESSAGE_ID, at: NOW },
          read: null,
        },
      ],
    });

    await expect(service.list(USER_ID, CONVERSATION_ID)).resolves.toEqual({
      conversationId: CONVERSATION_ID,
      items: [
        {
          userId: OTHER_USER_ID,
          version: 2,
          delivered: { messageId: MESSAGE_ID, at: NOW.toISOString() },
          read: null,
        },
      ],
    });
  });

  it('keeps the committed response when realtime publishing fails', async () => {
    const { repository, publisher, service } = createService();
    const logSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repository.markThrough.mockResolvedValue({
      status: 'updated',
      changed: true,
      receipt: receipt(),
    });
    publisher.publishUpdated.mockRejectedValue(new Error('socket unavailable'));

    await expect(
      service.markDelivered(USER_ID, CONVERSATION_ID, MESSAGE_ID),
    ).resolves.toMatchObject({ changed: true });
    expect(logSpy).toHaveBeenCalledWith(
      `Failed to publish receipt.delivered for ${MESSAGE_ID}`,
      expect.any(String),
    );
    logSpy.mockRestore();
  });
});

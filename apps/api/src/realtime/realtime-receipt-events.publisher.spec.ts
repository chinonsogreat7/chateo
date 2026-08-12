import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import type { ReceiptUpdateRecord } from '../receipts/receipts.types';
import { ChatGateway } from './chat.gateway';
import { RealtimeReceiptEventsPublisher } from './realtime-receipt-events.publisher';
import {
  RECEIPT_DELIVERED_EVENT,
  RECEIPT_READ_EVENT,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

const NOW = new Date('2026-08-12T21:30:00.000Z');
const USER_ONE_ID = '11111111-1111-4111-8111-111111111111';
const USER_TWO_ID = '22222222-2222-4222-8222-222222222222';

function receipt(
  overrides: Partial<ReceiptUpdateRecord> = {},
): ReceiptUpdateRecord {
  return {
    conversationId: '33333333-3333-4333-8333-333333333333',
    userId: USER_TWO_ID,
    status: 'DELIVERED',
    throughMessageId: '44444444-4444-4444-8444-444444444444',
    at: NOW,
    version: 1,
    delivered: {
      messageId: '44444444-4444-4444-8444-444444444444',
      at: NOW,
    },
    read: null,
    unreadCount: 2,
    participantIds: [USER_ONE_ID, USER_TWO_ID],
    ...overrides,
  };
}

function target(data: Partial<RealtimeSocketData>): RealtimeSocketTarget {
  return {
    id: `socket-${String(data.sessionId)}`,
    data,
    emit: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
  };
}

function createPublisher(sockets: RealtimeSocketTarget[]) {
  const findSocketsForUsers = jest.fn().mockResolvedValue(sockets);
  const isSessionActive = jest.fn();
  const publisher = new RealtimeReceiptEventsPublisher(
    { findSocketsForUsers } as unknown as ChatGateway,
    { isSessionActive } as unknown as AuthRepository,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
  );
  return { findSocketsForUsers, isSessionActive, publisher };
}

describe('RealtimeReceiptEventsPublisher', () => {
  it('emits a privacy-safe delivery event to every active participant device', async () => {
    const actorDevice = target({
      userId: USER_TWO_ID,
      sessionId: 'actor-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const participantDevice = target({
      userId: USER_ONE_ID,
      sessionId: 'participant-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findSocketsForUsers, isSessionActive, publisher } = createPublisher(
      [actorDevice, participantDevice],
    );
    isSessionActive.mockResolvedValue(true);

    await publisher.publishUpdated(
      receipt({ participantIds: [USER_ONE_ID, USER_TWO_ID, USER_ONE_ID] }),
    );

    expect(findSocketsForUsers).toHaveBeenCalledWith([
      USER_ONE_ID,
      USER_TWO_ID,
    ]);
    const payload = {
      conversationId: '33333333-3333-4333-8333-333333333333',
      userId: USER_TWO_ID,
      throughMessageId: '44444444-4444-4444-8444-444444444444',
      at: NOW.toISOString(),
      version: 1,
      delivered: {
        messageId: '44444444-4444-4444-8444-444444444444',
        at: NOW.toISOString(),
      },
      read: null,
    };
    expect(actorDevice.emit).toHaveBeenCalledWith(
      RECEIPT_DELIVERED_EVENT,
      payload,
    );
    expect(participantDevice.emit).toHaveBeenCalledWith(
      RECEIPT_DELIVERED_EVENT,
      payload,
    );
    expect(payload).not.toHaveProperty('participantIds');
    expect(payload).not.toHaveProperty('unreadCount');
  });

  it('uses the dedicated read event for an advanced read frontier', async () => {
    const socket = target({
      userId: USER_ONE_ID,
      sessionId: 'active-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { isSessionActive, publisher } = createPublisher([socket]);
    isSessionActive.mockResolvedValue(true);

    await publisher.publishUpdated(receipt({ status: 'READ' }));

    expect(socket.emit).toHaveBeenCalledWith(
      RECEIPT_READ_EVENT,
      expect.objectContaining({ userId: USER_TWO_ID }),
    );
  });

  it('disconnects expired, unauthorized, revoked, and unverifiable sockets', async () => {
    const expired = target({
      userId: USER_ONE_ID,
      sessionId: 'expired',
      tokenExpiresAt: NOW.getTime(),
    });
    const outsider = target({
      userId: '55555555-5555-4555-8555-555555555555',
      sessionId: 'outsider',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const revoked = target({
      userId: USER_TWO_ID,
      sessionId: 'revoked',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const unverifiable = target({
      userId: USER_ONE_ID,
      sessionId: 'repository-error',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { isSessionActive, publisher } = createPublisher([
      expired,
      outsider,
      revoked,
      unverifiable,
    ]);
    isSessionActive.mockImplementation((sessionId: string) => {
      if (sessionId === 'repository-error') {
        return Promise.reject(new Error('database unavailable'));
      }
      return Promise.resolve(false);
    });

    await expect(publisher.publishUpdated(receipt())).resolves.toBeUndefined();

    for (const socket of [expired, outsider, revoked, unverifiable]) {
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    }
    expect(isSessionActive).toHaveBeenCalledTimes(2);
  });
});

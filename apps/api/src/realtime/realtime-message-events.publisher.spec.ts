import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import type { MessageRecord } from '../messages/messages.types';
import { ChatGateway } from './chat.gateway';
import { RealtimeMessageEventsPublisher } from './realtime-message-events.publisher';
import {
  MESSAGE_CREATED_EVENT,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const USER_ONE_ID = '11111111-1111-4111-8111-111111111111';
const USER_TWO_ID = '22222222-2222-4222-8222-222222222222';

function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: '44444444-4444-4444-8444-444444444444',
    clientMessageId: '55555555-5555-4555-8555-555555555555',
    senderId: USER_ONE_ID,
    kind: 'TEXT',
    text: 'Hello from another device',
    createdAt: NOW,
    participantIds: [USER_ONE_ID, USER_TWO_ID],
    ...overrides,
  };
}

function target(data: Partial<RealtimeSocketData>) {
  const socket: RealtimeSocketTarget = {
    id: `socket-${String(data.sessionId)}`,
    data,
    emit: jest.fn().mockReturnValue(true),
    disconnect: jest.fn(),
  };
  return socket;
}

function createPublisher(sockets: RealtimeSocketTarget[]) {
  const findSocketsForUsers = jest.fn().mockResolvedValue(sockets);
  const isSessionActive = jest.fn();
  const publisher = new RealtimeMessageEventsPublisher(
    { findSocketsForUsers } as unknown as ChatGateway,
    { isSessionActive } as unknown as AuthRepository,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
  );
  return { findSocketsForUsers, isSessionActive, publisher };
}

describe('RealtimeMessageEventsPublisher', () => {
  it('emits a public message.created payload to every active participant socket', async () => {
    const first = target({
      userId: USER_ONE_ID,
      sessionId: 'session-one',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const second = target({
      userId: USER_TWO_ID,
      sessionId: 'session-two',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findSocketsForUsers, isSessionActive, publisher } = createPublisher(
      [first, second],
    );
    isSessionActive.mockResolvedValue(true);

    await publisher.publishCreated(
      message({ participantIds: [USER_ONE_ID, USER_TWO_ID, USER_ONE_ID] }),
    );

    expect(findSocketsForUsers).toHaveBeenCalledWith([
      USER_ONE_ID,
      USER_TWO_ID,
    ]);
    const expectedPayload = {
      id: '33333333-3333-4333-8333-333333333333',
      conversationId: '44444444-4444-4444-8444-444444444444',
      clientMessageId: '55555555-5555-4555-8555-555555555555',
      senderId: USER_ONE_ID,
      kind: 'text',
      text: 'Hello from another device',
      createdAt: NOW.toISOString(),
    };
    expect(first.emit).toHaveBeenCalledWith(
      MESSAGE_CREATED_EVENT,
      expectedPayload,
    );
    expect(second.emit).toHaveBeenCalledWith(
      MESSAGE_CREATED_EVENT,
      expectedPayload,
    );
    expect(expectedPayload).not.toHaveProperty('participantIds');
  });

  it('always includes the sender room for multi-device synchronization', async () => {
    const { findSocketsForUsers, publisher } = createPublisher([]);

    await publisher.publishCreated(message({ participantIds: [USER_TWO_ID] }));

    expect(findSocketsForUsers).toHaveBeenCalledWith([
      USER_TWO_ID,
      USER_ONE_ID,
    ]);
  });

  it('disconnects expired, revoked, and unverifiable sockets without emitting', async () => {
    const expired = target({
      userId: USER_ONE_ID,
      sessionId: 'expired-session',
      tokenExpiresAt: NOW.getTime(),
    });
    const revoked = target({
      userId: USER_TWO_ID,
      sessionId: 'revoked-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const unverifiable = target({
      userId: USER_ONE_ID,
      sessionId: 'repository-error',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { isSessionActive, publisher } = createPublisher([
      expired,
      revoked,
      unverifiable,
    ]);
    isSessionActive.mockImplementation((sessionId: string) => {
      if (sessionId === 'repository-error') {
        return Promise.reject(new Error('database unavailable'));
      }
      return Promise.resolve(false);
    });

    await expect(publisher.publishCreated(message())).resolves.toBeUndefined();

    for (const socket of [expired, revoked, unverifiable]) {
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
    }
    expect(isSessionActive).toHaveBeenCalledTimes(2);
  });
});

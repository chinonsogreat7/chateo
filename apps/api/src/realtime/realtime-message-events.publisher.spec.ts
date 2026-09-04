import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import type { MessageRecord } from '../messages/messages.types';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import { RealtimeMessageEventsPublisher } from './realtime-message-events.publisher';
import {
  CONVERSATION_HISTORY_CLEARED_EVENT,
  MESSAGE_CREATED_EVENT,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const USER_ONE_ID = '11111111-1111-4111-8111-111111111111';
const USER_TWO_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';

function message(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    conversationId: CONVERSATION_ID,
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
  const findActiveSessionIds = jest.fn(
    async (
      sessions: Array<{ sessionId: string; userId: string }>,
      now: Date,
    ) => {
      const activeSessionIds: string[] = [];
      for (const session of sessions) {
        if (await isSessionActive(session.sessionId, session.userId, now)) {
          activeSessionIds.push(session.sessionId);
        }
      }
      return activeSessionIds;
    },
  );
  const findAccessibleConversation = jest.fn().mockResolvedValue({
    conversationId: CONVERSATION_ID,
    participantIds: [USER_ONE_ID, USER_TWO_ID],
  });
  const publisher = new RealtimeMessageEventsPublisher(
    { findSocketsForUsers } as unknown as ChatGateway,
    { findActiveSessionIds, isSessionActive } as unknown as AuthRepository,
    {
      findAccessibleConversation,
    } as unknown as RealtimeConversationsRepository,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
  );
  return {
    findAccessibleConversation,
    findActiveSessionIds,
    findSocketsForUsers,
    isSessionActive,
    publisher,
  };
}

describe('RealtimeMessageEventsPublisher', () => {
  it('emits a clear boundary only to the clearing user active devices', async () => {
    const ownerDevice = target({
      userId: USER_ONE_ID,
      sessionId: 'session-one',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const unrelatedDevice = target({
      userId: USER_TWO_ID,
      sessionId: 'session-two',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const {
      findAccessibleConversation,
      findSocketsForUsers,
      isSessionActive,
      publisher,
    } = createPublisher([ownerDevice, unrelatedDevice]);
    isSessionActive.mockResolvedValue(true);

    await publisher.publishHistoryCleared({
      conversationId: CONVERSATION_ID,
      userId: USER_ONE_ID,
      changed: true,
      clearedAt: NOW,
      clearedThroughMessageId: '33333333-3333-4333-8333-333333333333',
      occurredAt: NOW,
    });

    expect(findSocketsForUsers).toHaveBeenCalledWith([USER_ONE_ID]);
    expect(ownerDevice.emit).toHaveBeenCalledWith(
      CONVERSATION_HISTORY_CLEARED_EVENT,
      {
        conversationId: CONVERSATION_ID,
        userId: USER_ONE_ID,
        clearedAt: NOW.toISOString(),
        clearedThroughMessageId: '33333333-3333-4333-8333-333333333333',
        occurredAt: NOW.toISOString(),
      },
    );
    expect(unrelatedDevice.emit).not.toHaveBeenCalled();
    expect(unrelatedDevice.disconnect).toHaveBeenCalledWith(true);
    expect(findAccessibleConversation).not.toHaveBeenCalled();
  });

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
    const {
      findAccessibleConversation,
      findSocketsForUsers,
      isSessionActive,
      publisher,
    } = createPublisher([first, second]);
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
      conversationId: CONVERSATION_ID,
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
    expect(findAccessibleConversation).toHaveBeenCalledTimes(1);
    expect(findAccessibleConversation).toHaveBeenCalledWith(
      CONVERSATION_ID,
      USER_ONE_ID,
    );
  });

  it('always includes the sender room for multi-device synchronization', async () => {
    const { findSocketsForUsers, publisher } = createPublisher([]);

    await publisher.publishCreated(message({ participantIds: [USER_TWO_ID] }));

    expect(findSocketsForUsers).toHaveBeenCalledWith([
      USER_TWO_ID,
      USER_ONE_ID,
    ]);
  });

  it('reuses one current-access lookup across a user multiple devices', async () => {
    const first = target({
      userId: USER_ONE_ID,
      sessionId: 'session-one-a',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const second = target({
      userId: USER_ONE_ID,
      sessionId: 'session-one-b',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findAccessibleConversation, isSessionActive, publisher } =
      createPublisher([first, second]);
    isSessionActive.mockResolvedValue(true);

    await publisher.publishCreated(message());

    expect(findAccessibleConversation).toHaveBeenCalledTimes(1);
    expect(findAccessibleConversation).toHaveBeenCalledWith(
      CONVERSATION_ID,
      USER_ONE_ID,
    );
    expect(isSessionActive).toHaveBeenCalledTimes(2);
    expect(first.emit).toHaveBeenCalledWith(
      MESSAGE_CREATED_EVENT,
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );
    expect(second.emit).toHaveBeenCalledWith(
      MESSAGE_CREATED_EVENT,
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );
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

  it('suppresses a socket that lost conversation membership before fan-out', async () => {
    const removedMember = target({
      userId: USER_TWO_ID,
      sessionId: 'removed-member-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findAccessibleConversation, isSessionActive, publisher } =
      createPublisher([removedMember]);
    isSessionActive.mockResolvedValue(true);
    findAccessibleConversation.mockResolvedValue(null);

    await publisher.publishCreated(message());

    expect(findAccessibleConversation).toHaveBeenCalledWith(
      CONVERSATION_ID,
      USER_ONE_ID,
    );
    expect(removedMember.emit).not.toHaveBeenCalled();
    expect(removedMember.disconnect).not.toHaveBeenCalled();
  });

  it('fails closed when current membership cannot be verified', async () => {
    const socket = target({
      userId: USER_TWO_ID,
      sessionId: 'access-error-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findAccessibleConversation, isSessionActive, publisher } =
      createPublisher([socket]);
    isSessionActive.mockResolvedValue(true);
    findAccessibleConversation.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(publisher.publishCreated(message())).resolves.toBeUndefined();

    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).not.toHaveBeenCalled();
  });
});

import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationEventsPublisher } from './realtime-conversation-events.publisher';
import {
  CONVERSATION_CREATED_EVENT,
  CONVERSATION_SETTINGS_UPDATED_EVENT,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const USER_ONE_ID = '11111111-1111-4111-8111-111111111111';
const USER_TWO_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

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
  const isSessionActive = jest.fn().mockResolvedValue(true);
  const publisher = new RealtimeConversationEventsPublisher(
    { findSocketsForUsers } as unknown as ChatGateway,
    { isSessionActive } as unknown as AuthRepository,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
  );
  return { findSocketsForUsers, isSessionActive, publisher };
}

describe('RealtimeConversationEventsPublisher', () => {
  it('notifies every participant device that a group was created', async () => {
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
    const { findSocketsForUsers, publisher } = createPublisher([first, second]);

    await publisher.publishCreated({
      conversationId: CONVERSATION_ID,
      type: 'GROUP',
      participantIds: [USER_ONE_ID, USER_TWO_ID, USER_ONE_ID],
      occurredAt: NOW,
    });

    expect(findSocketsForUsers).toHaveBeenCalledWith([
      USER_ONE_ID,
      USER_TWO_ID,
    ]);
    const payload = {
      conversationId: CONVERSATION_ID,
      type: 'group',
      occurredAt: NOW.toISOString(),
    };
    expect(first.emit).toHaveBeenCalledWith(
      CONVERSATION_CREATED_EVENT,
      payload,
    );
    expect(second.emit).toHaveBeenCalledWith(
      CONVERSATION_CREATED_EVENT,
      payload,
    );
  });

  it('sends personalized setting changes only to that user devices', async () => {
    const socket = target({
      userId: USER_ONE_ID,
      sessionId: 'session-one',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findSocketsForUsers, publisher } = createPublisher([socket]);

    await publisher.publishSettingsUpdated({
      conversationId: CONVERSATION_ID,
      userId: USER_ONE_ID,
      archivedAt: NOW,
      mutedAt: null,
      pinnedAt: NOW,
      occurredAt: NOW,
    });

    expect(findSocketsForUsers).toHaveBeenCalledWith([USER_ONE_ID]);
    expect(socket.emit).toHaveBeenCalledWith(
      CONVERSATION_SETTINGS_UPDATED_EVENT,
      {
        conversationId: CONVERSATION_ID,
        userId: USER_ONE_ID,
        archived: true,
        muted: false,
        pinned: true,
        archivedAt: NOW.toISOString(),
        mutedAt: null,
        pinnedAt: NOW.toISOString(),
        occurredAt: NOW.toISOString(),
      },
    );
  });

  it('disconnects a revoked socket without exposing the event', async () => {
    const socket = target({
      userId: USER_ONE_ID,
      sessionId: 'revoked-session',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { isSessionActive, publisher } = createPublisher([socket]);
    isSessionActive.mockResolvedValue(false);

    await publisher.publishCreated({
      conversationId: CONVERSATION_ID,
      type: 'DIRECT',
      participantIds: [USER_ONE_ID],
      occurredAt: NOW,
    });

    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
});

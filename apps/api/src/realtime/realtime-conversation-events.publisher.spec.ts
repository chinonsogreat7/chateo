import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import type { GroupChangedEventRecord } from '../conversations/conversation-events.publisher';
import { ChatStateService } from './chat-state.service';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import { RealtimeConversationEventsPublisher } from './realtime-conversation-events.publisher';
import {
  CONVERSATION_CREATED_EVENT,
  CONVERSATION_DELETED_EVENT,
  CONVERSATION_MEMBERS_ADDED_EVENT,
  CONVERSATION_MEMBER_REMOVED_EVENT,
  CONVERSATION_MEMBER_ROLE_UPDATED_EVENT,
  CONVERSATION_METADATA_UPDATED_EVENT,
  CONVERSATION_OWNER_TRANSFERRED_EVENT,
  CONVERSATION_SETTINGS_UPDATED_EVENT,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const USER_ONE_ID = '11111111-1111-4111-8111-111111111111';
const USER_TWO_ID = '22222222-2222-4222-8222-222222222222';
const USER_THREE_ID = '55555555-5555-4555-8555-555555555555';
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
  const findGroupParticipantIds = jest
    .fn()
    .mockResolvedValue([USER_ONE_ID, USER_TWO_ID, USER_THREE_ID]);
  const refreshConversationAccess = jest.fn().mockResolvedValue(undefined);
  const publisher = new RealtimeConversationEventsPublisher(
    { findSocketsForUsers } as unknown as ChatGateway,
    { findActiveSessionIds, isSessionActive } as unknown as AuthRepository,
    {
      findAccessibleConversation,
      findGroupParticipantIds,
    } as unknown as RealtimeConversationsRepository,
    { refreshConversationAccess } as unknown as ChatStateService,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
  );
  return {
    findAccessibleConversation,
    findActiveSessionIds,
    findGroupParticipantIds,
    findSocketsForUsers,
    isSessionActive,
    publisher,
    refreshConversationAccess,
  };
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
    const { findGroupParticipantIds, findSocketsForUsers, publisher } =
      createPublisher([first, second]);

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
    expect(findGroupParticipantIds).toHaveBeenCalledTimes(1);
  });

  it('sends personalized setting changes only to that user devices', async () => {
    const socket = target({
      userId: USER_ONE_ID,
      sessionId: 'session-one',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findAccessibleConversation, findSocketsForUsers, publisher } =
      createPublisher([socket]);

    await publisher.publishSettingsUpdated({
      conversationId: CONVERSATION_ID,
      userId: USER_ONE_ID,
      archivedAt: NOW,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: NOW,
      favoritedAt: NOW,
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
        favorited: true,
        archivedAt: NOW.toISOString(),
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: NOW.toISOString(),
        favoritedAt: NOW.toISOString(),
        occurredAt: NOW.toISOString(),
      },
    );
    expect(findAccessibleConversation).not.toHaveBeenCalled();
  });

  it('reuses one lifecycle access lookup across a user multiple devices', async () => {
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
    const { findGroupParticipantIds, isSessionActive, publisher } =
      createPublisher([first, second]);

    await publisher.publishGroupChanged({
      kind: 'metadata-updated',
      conversationId: CONVERSATION_ID,
      actorId: USER_ONE_ID,
      recipientIds: [USER_ONE_ID],
      occurredAt: NOW,
      name: 'One lookup',
      avatarUrl: null,
    });

    expect(findGroupParticipantIds).toHaveBeenCalledTimes(1);
    expect(isSessionActive).toHaveBeenCalledTimes(2);
    expect(first.emit).toHaveBeenCalledWith(
      CONVERSATION_METADATA_UPDATED_EVENT,
      expect.objectContaining({ name: 'One lookup' }),
    );
    expect(second.emit).toHaveBeenCalledWith(
      CONVERSATION_METADATA_UPDATED_EVENT,
      expect.objectContaining({ name: 'One lookup' }),
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

  it.each<{
    record: GroupChangedEventRecord;
    socketEvent: string;
    expectedPayload: Record<string, unknown>;
    refreshesAccess: boolean;
  }>([
    {
      record: {
        kind: 'metadata-updated',
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        recipientIds: [USER_ONE_ID],
        occurredAt: NOW,
        name: 'Project Team',
        avatarUrl: null,
      },
      socketEvent: CONVERSATION_METADATA_UPDATED_EVENT,
      expectedPayload: { name: 'Project Team', avatarUrl: null },
      refreshesAccess: false,
    },
    {
      record: {
        kind: 'members-added',
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        recipientIds: [USER_ONE_ID],
        occurredAt: NOW,
        memberIds: [USER_THREE_ID],
      },
      socketEvent: CONVERSATION_MEMBERS_ADDED_EVENT,
      expectedPayload: { memberIds: [USER_THREE_ID] },
      refreshesAccess: true,
    },
    {
      record: {
        kind: 'member-removed',
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        recipientIds: [USER_ONE_ID],
        occurredAt: NOW,
        memberId: USER_THREE_ID,
        reason: 'left',
      },
      socketEvent: CONVERSATION_MEMBER_REMOVED_EVENT,
      expectedPayload: { memberId: USER_THREE_ID, reason: 'left' },
      refreshesAccess: true,
    },
    {
      record: {
        kind: 'member-role-updated',
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        recipientIds: [USER_ONE_ID],
        occurredAt: NOW,
        memberId: USER_THREE_ID,
        role: 'ADMIN',
      },
      socketEvent: CONVERSATION_MEMBER_ROLE_UPDATED_EVENT,
      expectedPayload: { memberId: USER_THREE_ID, role: 'admin' },
      refreshesAccess: false,
    },
    {
      record: {
        kind: 'ownership-transferred',
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        recipientIds: [USER_ONE_ID],
        occurredAt: NOW,
        previousOwnerId: USER_TWO_ID,
        newOwnerId: USER_ONE_ID,
      },
      socketEvent: CONVERSATION_OWNER_TRANSFERRED_EVENT,
      expectedPayload: {
        previousOwnerId: USER_TWO_ID,
        newOwnerId: USER_ONE_ID,
      },
      refreshesAccess: false,
    },
    {
      record: {
        kind: 'deleted',
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        recipientIds: [USER_ONE_ID],
        occurredAt: NOW,
      },
      socketEvent: CONVERSATION_DELETED_EVENT,
      expectedPayload: {},
      refreshesAccess: true,
    },
  ])(
    'maps $record.kind to its privacy-safe socket event',
    async ({ record, socketEvent, expectedPayload, refreshesAccess }) => {
      const socket = target({
        userId: USER_ONE_ID,
        sessionId: `session-${record.kind}`,
        tokenExpiresAt: NOW.getTime() + 60_000,
      });
      const {
        findAccessibleConversation,
        findGroupParticipantIds,
        findSocketsForUsers,
        publisher,
        refreshConversationAccess,
      } = createPublisher([socket]);

      await publisher.publishGroupChanged(record);

      expect(socket.emit).toHaveBeenCalledWith(socketEvent, {
        conversationId: CONVERSATION_ID,
        actorId: USER_TWO_ID,
        occurredAt: NOW.toISOString(),
        ...expectedPayload,
      });
      expect(findAccessibleConversation).not.toHaveBeenCalled();
      if (record.kind === 'deleted') {
        expect(findGroupParticipantIds).not.toHaveBeenCalled();
      } else {
        expect(findGroupParticipantIds).toHaveBeenCalledWith(CONVERSATION_ID);
      }
      if (refreshesAccess) {
        expect(refreshConversationAccess).toHaveBeenCalledWith(CONVERSATION_ID);
        const refreshOrder =
          refreshConversationAccess.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER;
        const routingOrder =
          findSocketsForUsers.mock.invocationCallOrder[0] ??
          Number.MAX_SAFE_INTEGER;
        if (record.kind === 'members-added') {
          expect(routingOrder).toBeLessThan(refreshOrder);
        } else {
          expect(refreshOrder).toBeLessThan(routingOrder);
        }
      } else {
        expect(refreshConversationAccess).not.toHaveBeenCalled();
      }
    },
  );

  it('delivers only the departed member tombstone when current access is gone', async () => {
    const currentMember = target({
      userId: USER_ONE_ID,
      sessionId: 'current-member',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const departedMember = target({
      userId: USER_TWO_ID,
      sessionId: 'departed-member',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const outsider = target({
      userId: USER_THREE_ID,
      sessionId: 'outsider',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const {
      findAccessibleConversation,
      findGroupParticipantIds,
      findSocketsForUsers,
      publisher,
      refreshConversationAccess,
    } = createPublisher([currentMember, departedMember, outsider]);
    findGroupParticipantIds.mockResolvedValue([]);

    await publisher.publishGroupChanged({
      kind: 'member-removed',
      conversationId: CONVERSATION_ID,
      actorId: USER_ONE_ID,
      recipientIds: [USER_ONE_ID, USER_TWO_ID],
      occurredAt: NOW,
      memberId: USER_TWO_ID,
      reason: 'removed',
    });

    expect(findSocketsForUsers).toHaveBeenCalledWith([
      USER_ONE_ID,
      USER_TWO_ID,
    ]);
    expect(currentMember.emit).not.toHaveBeenCalled();
    expect(departedMember.emit).toHaveBeenCalledWith(
      CONVERSATION_MEMBER_REMOVED_EVENT,
      expect.objectContaining({ memberId: USER_TWO_ID, reason: 'removed' }),
    );
    expect(findAccessibleConversation).not.toHaveBeenCalled();
    expect(outsider.emit).not.toHaveBeenCalled();
    expect(outsider.disconnect).toHaveBeenCalledWith(true);
    expect(refreshConversationAccess.mock.invocationCallOrder[0]).toBeLessThan(
      findSocketsForUsers.mock.invocationCallOrder[0] ??
        Number.MAX_SAFE_INTEGER,
    );
  });

  it('delivers deletion tombstones to the committed pre-delete roster', async () => {
    const first = target({
      userId: USER_ONE_ID,
      sessionId: 'first-member',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const second = target({
      userId: USER_TWO_ID,
      sessionId: 'second-member',
      tokenExpiresAt: NOW.getTime() + 60_000,
    });
    const { findAccessibleConversation, publisher } = createPublisher([
      first,
      second,
    ]);
    findAccessibleConversation.mockResolvedValue(null);

    await publisher.publishGroupChanged({
      kind: 'deleted',
      conversationId: CONVERSATION_ID,
      actorId: USER_ONE_ID,
      recipientIds: [USER_ONE_ID, USER_TWO_ID],
      occurredAt: NOW,
    });

    expect(first.emit).toHaveBeenCalledWith(
      CONVERSATION_DELETED_EVENT,
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );
    expect(second.emit).toHaveBeenCalledWith(
      CONVERSATION_DELETED_EVENT,
      expect.objectContaining({ conversationId: CONVERSATION_ID }),
    );
    expect(findAccessibleConversation).not.toHaveBeenCalled();
  });
});

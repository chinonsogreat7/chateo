import { HttpStatus } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationEventsPublisher } from './conversation-events.publisher';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsService } from './conversations.service';
import type {
  DirectConversationRecord,
  GroupConversationRecord,
} from './conversations.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const PARTICIPANT_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_PARTICIPANT_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-08-12T12:00:00.000Z');

function conversation(
  overrides: Partial<DirectConversationRecord> = {},
): DirectConversationRecord {
  return {
    id: CONVERSATION_ID,
    type: 'DIRECT',
    otherParticipant: {
      id: PARTICIPANT_ID,
      displayName: 'Ada Okafor',
      avatarUrl: null,
    },
    latestMessage: null,
    unreadCount: 0,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function groupConversation(
  overrides: Partial<GroupConversationRecord> = {},
): GroupConversationRecord {
  return {
    id: CONVERSATION_ID,
    type: 'GROUP',
    name: 'Study Group',
    avatarUrl: null,
    participants: [
      {
        id: USER_ID,
        displayName: 'Current User',
        avatarUrl: null,
        role: 'OWNER',
      },
      {
        id: PARTICIPANT_ID,
        displayName: 'Ada Okafor',
        avatarUrl: null,
        role: 'MEMBER',
      },
    ],
    role: 'OWNER',
    latestMessage: null,
    unreadCount: 0,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createService() {
  const repository: jest.Mocked<ConversationsRepository> = {
    createOrGetDirect: jest.fn(),
    createGroup: jest.fn(),
    updateGroup: jest.fn(),
    addGroupMembers: jest.fn(),
    removeGroupMember: jest.fn(),
    updateGroupMemberRole: jest.fn(),
    transferGroupOwnership: jest.fn(),
    leaveGroup: jest.fn(),
    deleteGroup: jest.fn(),
    listForUser: jest.fn(),
    findForUser: jest.fn(),
  };
  const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };
  const eventsPublisher: jest.Mocked<ConversationEventsPublisher> = {
    publishCreated: jest.fn().mockResolvedValue(undefined),
    publishSettingsUpdated: jest.fn().mockResolvedValue(undefined),
    publishGroupChanged: jest.fn().mockResolvedValue(undefined),
  };
  return {
    repository,
    eventsPublisher,
    service: new ConversationsService(repository, clock, eventsPublisher),
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
    const { repository, eventsPublisher, service } = createService();
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
      settings: {
        archived: false,
        muted: false,
        pinned: false,
        favorited: false,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
      lastActivityAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(result.otherParticipant).not.toHaveProperty('phoneNumber');
    expect(eventsPublisher.publishCreated).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      type: 'DIRECT',
      participantIds: [USER_ID, PARTICIPANT_ID],
      occurredAt: NOW,
    });
  });

  it('creates and maps a group with normalized participants and roles', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.createGroup.mockResolvedValue({
      status: 'created',
      conversation: groupConversation({
        avatarUrl: 'https://example.com/groups/study.jpg',
      }),
    });

    const result = await service.createGroup(USER_ID.toUpperCase(), {
      name: '  Study Group  ',
      participantIds: [
        PARTICIPANT_ID.toUpperCase(),
        SECOND_PARTICIPANT_ID.toUpperCase(),
      ],
      avatarUrl: 'https://example.com/groups/study.jpg',
    });

    expect(repository.createGroup).toHaveBeenCalledWith({
      creatorId: USER_ID,
      name: 'Study Group',
      avatarUrl: 'https://example.com/groups/study.jpg',
      participantIds: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
      now: NOW,
    });
    expect(result).toEqual({
      id: CONVERSATION_ID,
      type: 'group',
      name: 'Study Group',
      avatarUrl: 'https://example.com/groups/study.jpg',
      participants: [
        {
          id: USER_ID,
          displayName: 'Current User',
          avatarUrl: null,
          role: 'owner',
        },
        {
          id: PARTICIPANT_ID,
          displayName: 'Ada Okafor',
          avatarUrl: null,
          role: 'member',
        },
      ],
      role: 'owner',
      latestMessage: null,
      unreadCount: 0,
      settings: {
        archived: false,
        muted: false,
        pinned: false,
        favorited: false,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
      lastActivityAt: NOW.toISOString(),
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(eventsPublisher.publishCreated).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      type: 'GROUP',
      participantIds: [USER_ID, PARTICIPANT_ID],
      occurredAt: NOW,
    });
  });

  it.each([
    { participantIds: [USER_ID] },
    {
      participantIds: [PARTICIPANT_ID, PARTICIPANT_ID.toUpperCase()],
    },
  ])(
    'rejects invalid group participants before persistence: $participantIds',
    async ({ participantIds }) => {
      const { repository, service } = createService();

      await expectApiError(
        service.createGroup(USER_ID, {
          name: 'Study Group',
          participantIds,
        }),
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_GROUP_PARTICIPANTS_INVALID',
      );

      expect(repository.createGroup).not.toHaveBeenCalled();
    },
  );

  it('conceals which selected group participant does not exist', async () => {
    const { repository, service } = createService();
    repository.createGroup.mockResolvedValue({
      status: 'participant-not-found',
    });

    await expectApiError(
      service.createGroup(USER_ID, {
        name: 'Study Group',
        participantIds: [PARTICIPANT_ID],
      }),
      HttpStatus.NOT_FOUND,
      'USER_NOT_FOUND',
    );
  });

  it('updates group metadata and publishes the committed snapshot', async () => {
    const { repository, eventsPublisher, service } = createService();
    const updated = groupConversation({
      name: 'Project Team',
      avatarUrl: 'https://example.com/groups/project.jpg',
    });
    repository.updateGroup.mockResolvedValue({
      status: 'updated',
      changed: true,
      conversation: updated,
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });

    const response = await service.updateGroup(USER_ID, CONVERSATION_ID, {
      name: '  Project Team  ',
      avatarUrl: 'https://example.com/groups/project.jpg',
    });

    expect(repository.updateGroup).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      name: 'Project Team',
      avatarUrl: 'https://example.com/groups/project.jpg',
      now: NOW,
    });
    expect(response).toMatchObject({
      type: 'group',
      name: 'Project Team',
      avatarUrl: 'https://example.com/groups/project.jpg',
    });
    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'metadata-updated',
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID],
      name: 'Project Team',
      avatarUrl: 'https://example.com/groups/project.jpg',
      occurredAt: NOW,
    });
  });

  it('rejects an empty group metadata update and does not publish no-op changes', async () => {
    const { repository, eventsPublisher, service } = createService();

    await expectApiError(
      service.updateGroup(USER_ID, CONVERSATION_ID, {}),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_GROUP_UPDATE_EMPTY',
    );
    expect(repository.updateGroup).not.toHaveBeenCalled();

    repository.updateGroup.mockResolvedValue({
      status: 'updated',
      changed: false,
      conversation: groupConversation(),
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });
    await service.updateGroup(USER_ID, CONVERSATION_ID, {
      name: 'Study Group',
    });
    expect(eventsPublisher.publishGroupChanged).not.toHaveBeenCalled();
  });

  it('adds normalized group members and notifies the resulting roster', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.addGroupMembers.mockResolvedValue({
      status: 'members-added',
      conversation: groupConversation({
        participants: [
          ...groupConversation().participants,
          {
            id: SECOND_PARTICIPANT_ID,
            displayName: 'Tunde Bello',
            avatarUrl: null,
            role: 'MEMBER',
          },
        ],
      }),
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });

    await service.addGroupMembers(USER_ID.toUpperCase(), CONVERSATION_ID, {
      participantIds: [SECOND_PARTICIPANT_ID.toUpperCase()],
    });

    expect(repository.addGroupMembers).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      participantIds: [SECOND_PARTICIPANT_ID],
      now: NOW,
    });
    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'members-added',
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
      memberIds: [SECOND_PARTICIPANT_ID],
      occurredAt: NOW,
    });
  });

  it('returns a committed group write without waiting for socket delivery', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.addGroupMembers.mockResolvedValue({
      status: 'members-added',
      conversation: groupConversation(),
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });
    let finishDelivery: (() => void) | undefined;
    eventsPublisher.publishGroupChanged.mockReturnValue(
      new Promise<void>((resolve) => {
        finishDelivery = resolve;
      }),
    );

    const request = service.addGroupMembers(USER_ID, CONVERSATION_ID, {
      participantIds: [SECOND_PARTICIPANT_ID],
    });
    const outcome = await Promise.race([
      request.then(() => 'response'),
      new Promise<'publisher-pending'>((resolve) => {
        setImmediate(() => resolve('publisher-pending'));
      }),
    ]);
    finishDelivery?.();

    expect(outcome).toBe('response');
    await expect(request).resolves.toMatchObject({
      id: CONVERSATION_ID,
      type: 'group',
    });
  });

  it.each([
    ['participant-not-found', HttpStatus.NOT_FOUND, 'USER_NOT_FOUND'],
    [
      'member-already-exists',
      HttpStatus.CONFLICT,
      'CONVERSATION_MEMBER_ALREADY_EXISTS',
    ],
    ['group-full', HttpStatus.CONFLICT, 'CONVERSATION_GROUP_FULL'],
    ['forbidden', HttpStatus.FORBIDDEN, 'CONVERSATION_GROUP_PERMISSION_DENIED'],
  ] as const)(
    'maps add-member status %s to its public API error',
    async (status, httpStatus, code) => {
      const { repository, service } = createService();
      repository.addGroupMembers.mockResolvedValue({ status });

      await expectApiError(
        service.addGroupMembers(USER_ID, CONVERSATION_ID, {
          participantIds: [SECOND_PARTICIPANT_ID],
        }),
        httpStatus,
        code,
      );
    },
  );

  it('removes a member and sends a tombstone to the previous roster', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.removeGroupMember.mockResolvedValue({
      status: 'member-removed',
      conversation: groupConversation({
        participants: [groupConversation().participants[0]!],
      }),
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });

    await service.removeGroupMember(USER_ID, CONVERSATION_ID, PARTICIPANT_ID);

    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'member-removed',
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID],
      memberId: PARTICIPANT_ID,
      reason: 'removed',
      occurredAt: NOW,
    });
  });

  it('requires the leave route for self-removal and protects the owner', async () => {
    const { repository, service } = createService();

    await expectApiError(
      service.removeGroupMember(USER_ID, CONVERSATION_ID, USER_ID),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_MEMBER_SELF_REMOVE_NOT_ALLOWED',
    );
    expect(repository.removeGroupMember).not.toHaveBeenCalled();

    repository.removeGroupMember.mockResolvedValue({
      status: 'owner-protected',
    });
    await expectApiError(
      service.removeGroupMember(USER_ID, CONVERSATION_ID, PARTICIPANT_ID),
      HttpStatus.CONFLICT,
      'CONVERSATION_OWNER_PROTECTED',
    );
  });

  it('changes a member role idempotently and emits only on change', async () => {
    const { repository, eventsPublisher, service } = createService();
    const promoted = groupConversation({
      participants: [
        groupConversation().participants[0]!,
        { ...groupConversation().participants[1]!, role: 'ADMIN' },
      ],
    });
    repository.updateGroupMemberRole.mockResolvedValueOnce({
      status: 'role-updated',
      changed: true,
      conversation: promoted,
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });

    const response = await service.updateGroupMemberRole(
      USER_ID,
      CONVERSATION_ID,
      PARTICIPANT_ID,
      { role: 'admin' },
    );
    expect(response.participants[1]?.role).toBe('admin');
    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'member-role-updated',
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID],
      memberId: PARTICIPANT_ID,
      role: 'ADMIN',
      occurredAt: NOW,
    });

    eventsPublisher.publishGroupChanged.mockClear();
    repository.updateGroupMemberRole.mockResolvedValueOnce({
      status: 'role-updated',
      changed: false,
      conversation: promoted,
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });
    await service.updateGroupMemberRole(
      USER_ID,
      CONVERSATION_ID,
      PARTICIPANT_ID,
      { role: 'admin' },
    );
    expect(eventsPublisher.publishGroupChanged).not.toHaveBeenCalled();
  });

  it('transfers ownership to another member and prevents a self-transfer', async () => {
    const { repository, eventsPublisher, service } = createService();
    const transferred = groupConversation({
      role: 'ADMIN',
      participants: [
        { ...groupConversation().participants[0]!, role: 'ADMIN' },
        { ...groupConversation().participants[1]!, role: 'OWNER' },
      ],
    });
    repository.transferGroupOwnership.mockResolvedValue({
      status: 'ownership-transferred',
      changed: true,
      conversation: transferred,
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });

    const response = await service.transferGroupOwnership(
      USER_ID,
      CONVERSATION_ID,
      { newOwnerId: PARTICIPANT_ID },
    );
    expect(response.role).toBe('admin');
    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'ownership-transferred',
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID],
      previousOwnerId: USER_ID,
      newOwnerId: PARTICIPANT_ID,
      occurredAt: NOW,
    });

    await expectApiError(
      service.transferGroupOwnership(USER_ID, CONVERSATION_ID, {
        newOwnerId: USER_ID,
      }),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_OWNER_TRANSFER_SELF_NOT_ALLOWED',
    );
  });

  it('lets a non-owner leave, while requiring owners to transfer first', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.leaveGroup.mockResolvedValueOnce({
      status: 'owner-transfer-required',
    });
    await expectApiError(
      service.leaveGroup(USER_ID, CONVERSATION_ID),
      HttpStatus.CONFLICT,
      'CONVERSATION_OWNER_TRANSFER_REQUIRED',
    );

    repository.leaveGroup.mockResolvedValueOnce({
      status: 'left',
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });
    await service.leaveGroup(PARTICIPANT_ID, CONVERSATION_ID);
    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'member-removed',
      conversationId: CONVERSATION_ID,
      actorId: PARTICIPANT_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID],
      memberId: PARTICIPANT_ID,
      reason: 'left',
      occurredAt: NOW,
    });
  });

  it('deletes an owned group and notifies its final roster', async () => {
    const { repository, eventsPublisher, service } = createService();
    repository.deleteGroup.mockResolvedValue({
      status: 'deleted',
      eventRecipientIds: [USER_ID, PARTICIPANT_ID],
    });

    await service.deleteGroup(USER_ID, CONVERSATION_ID);

    expect(eventsPublisher.publishGroupChanged).toHaveBeenCalledWith({
      kind: 'deleted',
      conversationId: CONVERSATION_ID,
      actorId: USER_ID,
      recipientIds: [USER_ID, PARTICIPANT_ID],
      occurredAt: NOW,
    });
  });

  it('maps the persisted latest message and actor unread count', async () => {
    const { repository, service } = createService();
    repository.findForUser.mockResolvedValue(
      conversation({
        latestMessage: {
          id: MESSAGE_ID,
          senderId: PARTICIPANT_ID,
          kind: 'TEXT',
          text: 'Are you joining us?',
          createdAt: NOW,
        },
        unreadCount: 3,
      }),
    );

    const result = await service.get(USER_ID, CONVERSATION_ID);

    expect(result.latestMessage).toEqual({
      id: MESSAGE_ID,
      senderId: PARTICIPANT_ID,
      kind: 'text',
      preview: 'Are you joining us?',
      createdAt: NOW.toISOString(),
    });
    expect(result.unreadCount).toBe(3);
  });

  it('hides a latest-message preview at the caller clear boundary', async () => {
    const { repository, service } = createService();
    repository.findForUser.mockResolvedValue(
      conversation({
        latestMessage: {
          id: MESSAGE_ID,
          senderId: PARTICIPANT_ID,
          kind: 'TEXT',
          text: 'Hidden only for this member',
          createdAt: NOW,
        },
        settings: {
          archivedAt: null,
          mutedAt: null,
          mutedUntil: null,
          pinnedAt: null,
          favoritedAt: null,
          clearedAt: NOW,
          clearedThroughMessageId: MESSAGE_ID,
        },
      }),
    );

    await expect(service.get(USER_ID, CONVERSATION_ID)).resolves.toMatchObject({
      latestMessage: null,
      settings: {
        clearedAt: NOW.toISOString(),
        clearedThroughMessageId: MESSAGE_ID,
      },
    });
  });

  it('reports an expired mute as inactive while preserving its timestamps', async () => {
    const { repository, service } = createService();
    const mutedAt = new Date(NOW.getTime() - 60_000);
    const mutedUntil = new Date(NOW.getTime() - 1);
    repository.findForUser.mockResolvedValue(
      conversation({
        settings: {
          archivedAt: null,
          mutedAt,
          mutedUntil,
          pinnedAt: null,
          favoritedAt: null,
          clearedAt: null,
          clearedThroughMessageId: null,
        },
      }),
    );

    await expect(service.get(USER_ID, CONVERSATION_ID)).resolves.toMatchObject({
      settings: {
        muted: false,
        mutedAt: mutedAt.toISOString(),
        mutedUntil: mutedUntil.toISOString(),
      },
    });
  });

  it('caps message previews at 120 Unicode code points', async () => {
    const { repository, service } = createService();
    const exactlyAtLimit = '👋'.repeat(120);
    const overLimit = `${exactlyAtLimit}x`;
    repository.findForUser
      .mockResolvedValueOnce(
        conversation({
          latestMessage: {
            id: MESSAGE_ID,
            senderId: PARTICIPANT_ID,
            kind: 'TEXT',
            text: exactlyAtLimit,
            createdAt: NOW,
          },
        }),
      )
      .mockResolvedValueOnce(
        conversation({
          latestMessage: {
            id: MESSAGE_ID,
            senderId: PARTICIPANT_ID,
            kind: 'TEXT',
            text: overLimit,
            createdAt: NOW,
          },
        }),
      );

    const exact = await service.get(USER_ID, CONVERSATION_ID);
    const truncated = await service.get(USER_ID, CONVERSATION_ID);

    expect(exact.latestMessage?.preview).toBe(exactlyAtLimit);
    expect(truncated.latestMessage?.preview).toBe(`${'👋'.repeat(119)}…`);
    expect(Array.from(truncated.latestMessage?.preview ?? '')).toHaveLength(
      120,
    );
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
      {
        id: second.id,
        pinned: false,
        archived: false,
        lastActivityAt: second.lastActivityAt,
      },
      3,
    );
  });

  it('preserves pinned cursor state across pages', async () => {
    const { repository, service } = createService();
    const pinned = conversation({
      settings: {
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: NOW,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });
    const lookahead = conversation({
      id: '33333333-3333-4333-8333-333333333334',
    });
    repository.listForUser
      .mockResolvedValueOnce([pinned, lookahead])
      .mockResolvedValueOnce([]);

    const page = await service.list(USER_ID, 1);
    await service.list(USER_ID, 1, page.pageInfo.nextCursor ?? undefined);

    expect(repository.listForUser).toHaveBeenNthCalledWith(
      2,
      USER_ID,
      {
        id: pinned.id,
        pinned: true,
        archived: false,
        lastActivityAt: pinned.lastActivityAt,
      },
      2,
    );
  });

  it('forces the archived filter for the dedicated archived list', async () => {
    const { repository, service } = createService();
    repository.listForUser.mockResolvedValue([]);

    await expect(service.listArchived(USER_ID, 20)).resolves.toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });
    expect(repository.listForUser).toHaveBeenCalledWith(
      USER_ID,
      null,
      21,
      true,
    );
  });

  it('rejects a cursor when its archive filter does not match the request', async () => {
    const { repository, service } = createService();
    const first = conversation();
    const lookahead = conversation({
      id: '33333333-3333-4333-8333-333333333334',
    });
    repository.listForUser.mockResolvedValueOnce([first, lookahead]);

    const page = await service.list(USER_ID, 1, undefined, true);
    await expectApiError(
      service.list(USER_ID, 1, page.pageInfo.nextCursor ?? undefined, false),
      HttpStatus.BAD_REQUEST,
      'CONVERSATION_CURSOR_INVALID',
    );

    expect(repository.listForUser).toHaveBeenCalledTimes(1);
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

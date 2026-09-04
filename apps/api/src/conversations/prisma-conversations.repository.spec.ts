import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaConversationsRepository } from './prisma-conversations.repository';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const PARTICIPANT_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_PARTICIPANT_ID = '55555555-5555-4555-8555-555555555555';
const NEW_PARTICIPANT_ID = '77777777-7777-4777-8777-777777777777';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-08-12T12:00:00.000Z');

interface RawConversationOptions {
  id?: string;
  actorUnreadCount?: number;
  actorArchivedAt?: Date | null;
  actorPinnedAt?: Date | null;
  includeLatestMessage?: boolean;
  lastActivityAt?: Date;
}

function rawConversation(options: RawConversationOptions = {}) {
  const conversationId = options.id ?? CONVERSATION_ID;
  return {
    id: conversationId,
    type: 'DIRECT',
    directUserOneId: PARTICIPANT_ID,
    directUserTwoId: USER_ID,
    lastActivityAt: options.lastActivityAt ?? NOW,
    createdAt: NOW,
    updatedAt: NOW,
    members: [
      {
        conversationId,
        userId: USER_ID,
        joinedAt: NOW,
        role: 'MEMBER',
        archivedAt: options.actorArchivedAt ?? null,
        mutedAt: null,
        pinnedAt: options.actorPinnedAt ?? null,
        unreadCount: options.actorUnreadCount ?? 0,
        lastReadAt: null,
        user: { id: USER_ID, displayName: 'Current User', avatarUrl: null },
      },
      {
        conversationId,
        userId: PARTICIPANT_ID,
        joinedAt: NOW,
        role: 'MEMBER',
        archivedAt: null,
        mutedAt: null,
        pinnedAt: null,
        unreadCount: 0,
        lastReadAt: null,
        user: {
          id: PARTICIPANT_ID,
          displayName: 'Ada Okafor',
          avatarUrl: null,
        },
      },
    ],
    messages: options.includeLatestMessage
      ? [
          {
            id: MESSAGE_ID,
            senderId: PARTICIPANT_ID,
            kind: 'TEXT',
            text: 'Latest persisted message',
            createdAt: NOW,
          },
        ]
      : [],
  };
}

function rawGroupConversation() {
  return {
    id: CONVERSATION_ID,
    type: 'GROUP',
    directUserOneId: null,
    directUserTwoId: null,
    name: 'Study Group',
    avatarUrl: 'https://example.com/groups/study.jpg',
    createdById: USER_ID,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    members: [
      {
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        joinedAt: NOW,
        role: 'OWNER',
        archivedAt: null,
        mutedAt: null,
        pinnedAt: null,
        unreadCount: 0,
        lastReadAt: null,
        user: { id: USER_ID, displayName: 'Current User', avatarUrl: null },
      },
      {
        conversationId: CONVERSATION_ID,
        userId: PARTICIPANT_ID,
        joinedAt: NOW,
        role: 'MEMBER',
        archivedAt: null,
        mutedAt: null,
        pinnedAt: null,
        unreadCount: 0,
        lastReadAt: null,
        user: {
          id: PARTICIPANT_ID,
          displayName: 'Ada Okafor',
          avatarUrl: null,
        },
      },
      {
        conversationId: CONVERSATION_ID,
        userId: SECOND_PARTICIPANT_ID,
        joinedAt: NOW,
        role: 'MEMBER',
        archivedAt: null,
        mutedAt: null,
        pinnedAt: null,
        unreadCount: 0,
        lastReadAt: null,
        user: {
          id: SECOND_PARTICIPANT_ID,
          displayName: 'Tunde Bello',
          avatarUrl: null,
        },
      },
    ],
    messages: [],
  };
}

function rawGroupMember(
  userId: string,
  role: 'OWNER' | 'ADMIN' | 'MEMBER' = 'MEMBER',
) {
  return {
    conversationId: CONVERSATION_ID,
    userId,
    joinedAt: NOW,
    role,
    archivedAt: null,
    mutedAt: null,
    pinnedAt: null,
    unreadCount: 0,
    lastReadAt: null,
    user: { id: userId, displayName: 'Group member', avatarUrl: null },
  };
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function createRepository() {
  const transaction = jest.fn();
  const findUnique = jest.fn();
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const prisma = {
    $transaction: transaction,
    conversation: { findUnique, findMany, findFirst },
    userBlock: { findFirst: blockFindFirst },
  } as unknown as PrismaService;
  return {
    repository: new PrismaConversationsRepository(prisma),
    transaction,
    findUnique,
    findMany,
    findFirst,
    blockFindFirst,
  };
}

function successfulTransaction(existing: unknown = null) {
  const findUnique = jest.fn().mockResolvedValue(existing);
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const participantFindUnique = jest
    .fn()
    .mockResolvedValue({ id: PARTICIPANT_ID });
  const create = jest.fn().mockResolvedValue(rawConversation());
  const client = {
    conversation: { findUnique, create },
    user: { findUnique: participantFindUnique },
    userBlock: { findFirst: blockFindFirst },
  };
  return {
    client,
    findUnique,
    blockFindFirst,
    participantFindUnique,
    create,
  };
}

describe('PrismaConversationsRepository', () => {
  it('creates a canonical direct pair and both memberships transactionally', async () => {
    const { repository, transaction } = createRepository();
    const transactionState = successfulTransaction();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transactionState.client),
    );

    await expect(
      repository.createOrGetDirect(USER_ID, PARTICIPANT_ID, NOW),
    ).resolves.toMatchObject({
      status: 'created',
      conversation: {
        id: CONVERSATION_ID,
        otherParticipant: { id: PARTICIPANT_ID },
        latestMessage: null,
        unreadCount: 0,
      },
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(transactionState.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          directUserOneId: PARTICIPANT_ID,
          directUserTwoId: USER_ID,
          lastActivityAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
          members: {
            create: [
              { userId: USER_ID, joinedAt: NOW },
              { userId: PARTICIPANT_ID, joinedAt: NOW },
            ],
          },
        }),
      }),
    );
  });

  it('returns the existing direct conversation without creating another', async () => {
    const { repository, transaction } = createRepository();
    const transactionState = successfulTransaction(rawConversation());
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transactionState.client),
    );

    await expect(
      repository.createOrGetDirect(USER_ID, PARTICIPANT_ID, NOW),
    ).resolves.toMatchObject({ status: 'existing' });
    expect(transactionState.participantFindUnique).not.toHaveBeenCalled();
    expect(transactionState.create).not.toHaveBeenCalled();
  });

  it('returns participant-not-found without creating a conversation', async () => {
    const { repository, transaction } = createRepository();
    const transactionState = successfulTransaction();
    transactionState.participantFindUnique.mockResolvedValue(null);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transactionState.client),
    );

    await expect(
      repository.createOrGetDirect(USER_ID, PARTICIPANT_ID, NOW),
    ).resolves.toEqual({ status: 'participant-not-found' });
    expect(transactionState.create).not.toHaveBeenCalled();
  });

  it('conceals direct creation when either user has blocked the other', async () => {
    const { repository, transaction } = createRepository();
    const transactionState = successfulTransaction();
    transactionState.blockFindFirst.mockResolvedValue({
      blockerId: PARTICIPANT_ID,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(transactionState.client),
    );

    await expect(
      repository.createOrGetDirect(USER_ID, PARTICIPANT_ID, NOW),
    ).resolves.toEqual({ status: 'participant-not-found' });
    expect(transactionState.findUnique).not.toHaveBeenCalled();
    expect(transactionState.participantFindUnique).not.toHaveBeenCalled();
    expect(transactionState.create).not.toHaveBeenCalled();
  });

  it('validates participants and creates owner/member group roles atomically', async () => {
    const { repository, transaction } = createRepository();
    const blockFindFirst = jest.fn().mockResolvedValue(null);
    const findMany = jest
      .fn()
      .mockResolvedValue([
        { id: PARTICIPANT_ID },
        { id: SECOND_PARTICIPANT_ID },
      ]);
    const create = jest.fn().mockResolvedValue(rawGroupConversation());
    const client = {
      conversation: { create },
      user: { findMany },
      userBlock: { findFirst: blockFindFirst },
    };
    transaction.mockImplementation(
      async (operation: (transactionClient: unknown) => Promise<unknown>) =>
        operation(client),
    );

    await expect(
      repository.createGroup({
        creatorId: USER_ID,
        name: 'Study Group',
        avatarUrl: 'https://example.com/groups/study.jpg',
        participantIds: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'created',
      conversation: {
        type: 'GROUP',
        name: 'Study Group',
        role: 'OWNER',
        participants: [
          { id: USER_ID, role: 'OWNER' },
          { id: PARTICIPANT_ID, role: 'MEMBER' },
          { id: SECOND_PARTICIPANT_ID, role: 'MEMBER' },
        ],
      },
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(blockFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            blockerId: USER_ID,
            blockedId: { in: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID] },
          },
          {
            blockerId: { in: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID] },
            blockedId: USER_ID,
          },
        ],
      },
      select: { blockerId: true },
    });
    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { in: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID] },
      },
      select: { id: true },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'GROUP',
          name: 'Study Group',
          avatarUrl: 'https://example.com/groups/study.jpg',
          createdById: USER_ID,
          members: {
            create: [
              { userId: USER_ID, joinedAt: NOW, role: 'OWNER' },
              {
                userId: PARTICIPANT_ID,
                joinedAt: NOW,
                role: 'MEMBER',
              },
              {
                userId: SECOND_PARTICIPANT_ID,
                joinedAt: NOW,
                role: 'MEMBER',
              },
            ],
          },
        }),
      }),
    );
  });

  it('does not create a group unless every selected participant exists', async () => {
    const { repository, transaction } = createRepository();
    const blockFindFirst = jest.fn().mockResolvedValue(null);
    const findMany = jest.fn().mockResolvedValue([{ id: PARTICIPANT_ID }]);
    const create = jest.fn();
    transaction.mockImplementation(
      async (operation: (transactionClient: unknown) => Promise<unknown>) =>
        operation({
          conversation: { create },
          user: { findMany },
          userBlock: { findFirst: blockFindFirst },
        }),
    );

    await expect(
      repository.createGroup({
        creatorId: USER_ID,
        name: 'Study Group',
        avatarUrl: null,
        participantIds: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'participant-not-found' });
    expect(create).not.toHaveBeenCalled();
  });

  it('conceals group creation when the creator and any invitee are blocked', async () => {
    const { repository, transaction } = createRepository();
    const blockFindFirst = jest.fn().mockResolvedValue({
      blockerId: PARTICIPANT_ID,
    });
    const findMany = jest.fn();
    const create = jest.fn();
    transaction.mockImplementation(
      async (operation: (transactionClient: unknown) => Promise<unknown>) =>
        operation({
          conversation: { create },
          user: { findMany },
          userBlock: { findFirst: blockFindFirst },
        }),
    );

    await expect(
      repository.createGroup({
        creatorId: USER_ID,
        name: 'Study Group',
        avatarUrl: null,
        participantIds: [PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'participant-not-found' });
    expect(findMany).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('retries serializable write conflicts with a bounded attempt count', async () => {
    const { repository, transaction } = createRepository();
    const transactionState = successfulTransaction(rawConversation());
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(transactionState.client),
      );

    await expect(
      repository.createOrGetDirect(USER_ID, PARTICIPANT_ID, NOW),
    ).resolves.toMatchObject({ status: 'existing' });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('reads and returns the concurrent winner after a unique conflict', async () => {
    const { repository, transaction, findUnique } = createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2002'));
    findUnique.mockResolvedValue(rawConversation());

    await expect(
      repository.createOrGetDirect(USER_ID, PARTICIPANT_ID, NOW),
    ).resolves.toMatchObject({ status: 'existing' });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          directUserOneId_directUserTwoId: {
            directUserOneId: PARTICIPANT_ID,
            directUserTwoId: USER_ID,
          },
        },
      }),
    );
  });

  it('lists pinned conversations first and fills the page with unpinned conversations', async () => {
    const { repository, findMany } = createRepository();
    const pinnedId = '33333333-3333-4333-8333-333333333335';
    const unpinnedId = '33333333-3333-4333-8333-333333333334';
    findMany
      .mockResolvedValueOnce([
        rawConversation({ id: pinnedId, actorPinnedAt: NOW }),
      ])
      .mockResolvedValueOnce([rawConversation({ id: unpinnedId })]);

    const result = await repository.listForUser(USER_ID, null, 3);

    expect(result.map((conversation) => conversation.id)).toEqual([
      pinnedId,
      unpinnedId,
    ]);
    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          members: {
            some: {
              userId: USER_ID,
              archivedAt: null,
              pinnedAt: { not: null },
            },
          },
        },
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        take: 3,
      }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          members: {
            some: {
              userId: USER_ID,
              archivedAt: null,
              pinnedAt: null,
            },
          },
        },
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        take: 2,
      }),
    );
  });

  it('continues pinned keyset pagination before crossing into unpinned rows', async () => {
    const { repository, findMany } = createRepository();
    const cursor = {
      pinned: true,
      archived: false,
      lastActivityAt: new Date('2026-08-12T11:00:00.000Z'),
      id: CONVERSATION_ID,
    };
    findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([rawConversation()]);

    await repository.listForUser(USER_ID, cursor, 21);

    expect(findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          members: {
            some: {
              userId: USER_ID,
              archivedAt: null,
              pinnedAt: { not: null },
            },
          },
          OR: [
            { lastActivityAt: { lt: cursor.lastActivityAt } },
            {
              lastActivityAt: cursor.lastActivityAt,
              id: { lt: cursor.id },
            },
          ],
        }),
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          members: {
            some: {
              userId: USER_ID,
              archivedAt: null,
              pinnedAt: null,
            },
          },
        },
        take: 21,
      }),
    );
  });

  it('continues an unpinned cursor without querying the pinned segment again', async () => {
    const { repository, findMany } = createRepository();
    findMany.mockResolvedValue([rawConversation()]);
    const cursor = {
      pinned: false,
      archived: false,
      lastActivityAt: new Date('2026-08-12T11:00:00.000Z'),
      id: CONVERSATION_ID,
    };

    await repository.listForUser(USER_ID, cursor, 21);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: {
            some: {
              userId: USER_ID,
              archivedAt: null,
              pinnedAt: null,
            },
          },
          OR: [
            { lastActivityAt: { lt: cursor.lastActivityAt } },
            {
              lastActivityAt: cursor.lastActivityAt,
              id: { lt: cursor.id },
            },
          ],
        }),
        orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
        take: 21,
      }),
    );
    expect(findMany.mock.calls[0]?.[0]?.where).not.toHaveProperty('type');
  });

  it('lists archived memberships only when explicitly requested', async () => {
    const { repository, findMany } = createRepository();
    findMany.mockResolvedValue([]);

    await repository.listForUser(USER_ID, null, 21, true);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: {
            some: {
              userId: USER_ID,
              archivedAt: { not: null },
              pinnedAt: { not: null },
            },
          },
        }),
      }),
    );
  });

  it('scopes detail reads to a member and selects no phone numbers', async () => {
    const { repository, findFirst } = createRepository();
    findFirst.mockResolvedValue(
      rawConversation({ actorUnreadCount: 4, includeLatestMessage: true }),
    );

    const result = await repository.findForUser(CONVERSATION_ID, USER_ID);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: CONVERSATION_ID,
          members: { some: { userId: USER_ID } },
        }),
      }),
    );
    expect(result?.otherParticipant).not.toHaveProperty('phoneNumber');
    expect(result).toMatchObject({
      unreadCount: 4,
      latestMessage: {
        id: MESSAGE_ID,
        senderId: PARTICIPANT_ID,
        kind: 'TEXT',
        text: 'Latest persisted message',
        createdAt: NOW,
      },
    });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          members: expect.objectContaining({
            select: expect.objectContaining({
              userId: true,
              unreadCount: true,
            }),
          }),
          messages: {
            select: {
              id: true,
              senderId: true,
              kind: true,
              text: true,
              createdAt: true,
            },
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
          },
        }),
      }),
    );
    expect(JSON.stringify(findFirst.mock.calls[0])).not.toContain(
      'phoneNumber',
    );
  });

  it('maps group metadata, participants, and the requesting member role', async () => {
    const { repository, findFirst } = createRepository();
    findFirst.mockResolvedValue(rawGroupConversation());

    const result = await repository.findForUser(CONVERSATION_ID, USER_ID);

    expect(result).toMatchObject({
      id: CONVERSATION_ID,
      type: 'GROUP',
      name: 'Study Group',
      avatarUrl: 'https://example.com/groups/study.jpg',
      role: 'OWNER',
      participants: [
        { id: USER_ID, role: 'OWNER' },
        { id: PARTICIPANT_ID, role: 'MEMBER' },
        { id: SECOND_PARTICIPANT_ID, role: 'MEMBER' },
      ],
    });
    expect(findFirst.mock.calls[0]?.[0]?.where).not.toHaveProperty('type');
    expect(JSON.stringify(result)).not.toContain('phoneNumber');
  });

  it('updates group metadata without changing message activity or creator provenance', async () => {
    const { repository, transaction } = createRepository();
    const original = rawGroupConversation();
    const updated = {
      ...rawGroupConversation(),
      name: 'Renamed Group',
      avatarUrl: null,
      updatedAt: NOW,
    };
    const findUnique = jest.fn().mockResolvedValue(original);
    const update = jest.fn().mockResolvedValue(updated);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ conversation: { findUnique, update } }),
    );

    await expect(
      repository.updateGroup({
        conversationId: CONVERSATION_ID.toUpperCase(),
        actorId: USER_ID.toUpperCase(),
        name: 'Renamed Group',
        avatarUrl: null,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      conversation: { name: 'Renamed Group', avatarUrl: null },
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });
    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CONVERSATION_ID } }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CONVERSATION_ID },
        data: {
          name: 'Renamed Group',
          avatarUrl: null,
          updatedAt: NOW,
        },
      }),
    );
    expect(update.mock.calls[0]?.[0]?.data).not.toHaveProperty(
      'lastActivityAt',
    );
    expect(update.mock.calls[0]?.[0]?.data).not.toHaveProperty('createdById');
  });

  it('allows admins to update metadata and treats unchanged values as a no-op', async () => {
    const { repository, transaction } = createRepository();
    const group = rawGroupConversation();
    group.members[0]!.role = 'ADMIN';
    group.members[2]!.role = 'OWNER';
    const findUnique = jest.fn().mockResolvedValue(group);
    const update = jest.fn();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ conversation: { findUnique, update } }),
    );

    await expect(
      repository.updateGroup({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        name: 'Study Group',
        avatarUrl: 'https://example.com/groups/study.jpg',
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'updated', changed: false });
    expect(update).not.toHaveBeenCalled();
  });

  it('adds validated members as members and returns post-add recipients', async () => {
    const { repository, transaction } = createRepository();
    const original = rawGroupConversation();
    const updated = rawGroupConversation();
    updated.members.push(rawGroupMember(NEW_PARTICIPANT_ID));
    const findUnique = jest.fn().mockResolvedValue(original);
    const update = jest.fn().mockResolvedValue(updated);
    const blockFindFirst = jest.fn().mockResolvedValue(null);
    const userFindMany = jest
      .fn()
      .mockResolvedValue([{ id: NEW_PARTICIPANT_ID }]);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update },
          userBlock: { findFirst: blockFindFirst },
          user: { findMany: userFindMany },
        }),
    );

    await expect(
      repository.addGroupMembers({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        participantIds: [NEW_PARTICIPANT_ID.toUpperCase()],
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'members-added',
      conversation: {
        participants: expect.arrayContaining([
          expect.objectContaining({
            id: NEW_PARTICIPANT_ID,
            role: 'MEMBER',
          }),
        ]),
      },
      eventRecipientIds: [
        USER_ID,
        PARTICIPANT_ID,
        SECOND_PARTICIPANT_ID,
        NEW_PARTICIPANT_ID,
      ],
    });
    expect(blockFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            blockerId: USER_ID,
            blockedId: { in: [NEW_PARTICIPANT_ID] },
          },
          {
            blockerId: { in: [NEW_PARTICIPANT_ID] },
            blockedId: USER_ID,
          },
        ],
      },
      select: { blockerId: true },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          updatedAt: NOW,
          members: {
            create: [
              {
                userId: NEW_PARTICIPANT_ID,
                joinedAt: NOW,
                role: 'MEMBER',
              },
            ],
          },
        },
      }),
    );
    expect(update.mock.calls[0]?.[0]?.data).not.toHaveProperty(
      'lastActivityAt',
    );
  });

  it('rejects existing additions and enforces the 100-member group limit', async () => {
    const { repository, transaction } = createRepository();
    const existing = rawGroupConversation();
    const full = rawGroupConversation();
    while (full.members.length < 100) {
      const suffix = String(full.members.length).padStart(12, '0');
      full.members.push(rawGroupMember(`00000000-0000-4000-8000-${suffix}`));
    }
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(full);
    const blockFindFirst = jest.fn();
    const userFindMany = jest.fn();
    const update = jest.fn();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update },
          userBlock: { findFirst: blockFindFirst },
          user: { findMany: userFindMany },
        }),
    );

    await expect(
      repository.addGroupMembers({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        participantIds: [PARTICIPANT_ID],
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'member-already-exists' });
    await expect(
      repository.addGroupMembers({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        participantIds: [NEW_PARTICIPANT_ID],
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'group-full' });
    expect(blockFindFirst).not.toHaveBeenCalled();
    expect(userFindMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    ['P2002', 'member-already-exists'],
    ['P2003', 'participant-not-found'],
    ['P2025', 'conversation-not-found'],
  ])('maps add-member %s races to %s', async (code, status) => {
    const { repository, transaction } = createRepository();
    transaction.mockRejectedValue(knownRequestError(code));

    await expect(
      repository.addGroupMembers({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        participantIds: [NEW_PARTICIPANT_ID],
        now: NOW,
      }),
    ).resolves.toEqual({ status });
  });

  it('removes a member while retaining the pre-removal event recipients', async () => {
    const { repository, transaction } = createRepository();
    const original = rawGroupConversation();
    const updated = rawGroupConversation();
    updated.members = updated.members.filter(
      (member) => member.userId !== PARTICIPANT_ID,
    );
    const findUnique = jest.fn().mockResolvedValue(original);
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue(updated);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update },
          conversationMember: { deleteMany },
        }),
    );

    await expect(
      repository.removeGroupMember({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        memberId: PARTICIPANT_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'member-removed',
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { conversationId: CONVERSATION_ID, userId: PARTICIPANT_ID },
    });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { updatedAt: NOW } }),
    );
  });

  it('protects the owner and prevents an admin from removing another admin', async () => {
    const { repository, transaction } = createRepository();
    const owned = rawGroupConversation();
    const administered = rawGroupConversation();
    administered.members[0]!.role = 'ADMIN';
    administered.members[1]!.role = 'ADMIN';
    administered.members[2]!.role = 'OWNER';
    const findUnique = jest
      .fn()
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce(administered);
    const deleteMany = jest.fn();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update: jest.fn() },
          conversationMember: { deleteMany },
        }),
    );

    await expect(
      repository.removeGroupMember({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        memberId: USER_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'owner-protected' });
    await expect(
      repository.removeGroupMember({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        memberId: PARTICIPANT_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'forbidden' });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('lets only the owner change a non-owner member role', async () => {
    const { repository, transaction } = createRepository();
    const original = rawGroupConversation();
    const updated = rawGroupConversation();
    updated.members[1]!.role = 'ADMIN';
    const findUnique = jest.fn().mockResolvedValue(original);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue(updated);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update },
          conversationMember: { updateMany },
        }),
    );

    await expect(
      repository.updateGroupMemberRole({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        memberId: PARTICIPANT_ID,
        role: 'ADMIN',
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'role-updated',
      changed: true,
      conversation: {
        participants: expect.arrayContaining([
          expect.objectContaining({ id: PARTICIPANT_ID, role: 'ADMIN' }),
        ]),
      },
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        userId: PARTICIPANT_ID,
        role: 'MEMBER',
      },
      data: { role: 'ADMIN' },
    });
  });

  it('transfers ownership atomically without changing createdById', async () => {
    const { repository, transaction } = createRepository();
    const original = rawGroupConversation();
    const updated = rawGroupConversation();
    updated.members[0]!.role = 'ADMIN';
    updated.members[1]!.role = 'OWNER';
    const findUnique = jest.fn().mockResolvedValue(original);
    const updateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const update = jest.fn().mockResolvedValue(updated);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update },
          conversationMember: { updateMany },
        }),
    );

    await expect(
      repository.transferGroupOwnership({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        memberId: PARTICIPANT_ID,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'ownership-transferred',
      changed: true,
      conversation: { role: 'ADMIN' },
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        role: 'OWNER',
      },
      data: { role: 'ADMIN' },
    });
    expect(updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        conversationId: CONVERSATION_ID,
        userId: PARTICIPANT_ID,
        role: 'MEMBER',
      },
      data: { role: 'OWNER' },
    });
    expect(update.mock.calls[0]?.[0]?.data).toEqual({ updatedAt: NOW });
    expect(update.mock.calls[0]?.[0]?.data).not.toHaveProperty('createdById');
  });

  it('requires ownership transfer before the owner can leave', async () => {
    const { repository, transaction } = createRepository();
    const findUnique = jest.fn().mockResolvedValue(rawGroupConversation());
    const deleteMany = jest.fn();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update: jest.fn() },
          conversationMember: { deleteMany },
        }),
    );

    await expect(
      repository.leaveGroup({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        now: NOW,
      }),
    ).resolves.toEqual({ status: 'owner-transfer-required' });
    expect(deleteMany).not.toHaveBeenCalled();
  });

  it('lets a non-owner leave and notifies the pre-leave member set', async () => {
    const { repository, transaction } = createRepository();
    const findUnique = jest.fn().mockResolvedValue(rawGroupConversation());
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const update = jest.fn().mockResolvedValue({ id: CONVERSATION_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, update },
          conversationMember: { deleteMany },
        }),
    );

    await expect(
      repository.leaveGroup({
        conversationId: CONVERSATION_ID,
        actorId: PARTICIPANT_ID,
        now: NOW,
      }),
    ).resolves.toEqual({
      status: 'left',
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID },
      data: { updatedAt: NOW },
      select: { id: true },
    });
  });

  it('allows only the group owner to delete and returns pre-delete recipients', async () => {
    const { repository, transaction } = createRepository();
    const findUnique = jest.fn().mockResolvedValue(rawGroupConversation());
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversation: { findUnique, deleteMany },
        }),
    );

    await expect(
      repository.deleteGroup({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        now: NOW,
      }),
    ).resolves.toEqual({
      status: 'deleted',
      eventRecipientIds: [USER_ID, PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
    });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { id: CONVERSATION_ID, type: 'GROUP' },
    });
  });

  it('retries group mutations at most three times on serializable conflicts', async () => {
    const { repository, transaction } = createRepository();
    const group = rawGroupConversation();
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation({ conversation: { findUnique: jest.fn(() => group) } }),
      );

    await expect(
      repository.updateGroup({
        conversationId: CONVERSATION_ID,
        actorId: USER_ID,
        name: group.name,
        now: NOW,
      }),
    ).resolves.toMatchObject({ status: 'updated', changed: false });
    expect(transaction).toHaveBeenCalledTimes(3);
    for (const call of transaction.mock.calls) {
      expect(call[1]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
    }
  });
});

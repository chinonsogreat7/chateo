import { MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaMessagesRepository } from './prisma-messages.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_CONVERSATION_ID = '33333333-3333-4333-8333-333333333334';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const CLIENT_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-08-12T16:00:00.000Z');

function rawMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    kind: MessageKind.TEXT,
    text: 'Hello!',
    createdAt: NOW,
    ...overrides,
  };
}

function sendInput() {
  return {
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: 'Hello!',
    now: NOW,
  };
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function createRepository() {
  const memberFindMany = jest.fn();
  const conversationFindUnique = jest.fn().mockResolvedValue({
    type: 'DIRECT',
    members: [
      { userId: USER_ID, clearedAt: null },
      { userId: OTHER_USER_ID, clearedAt: null },
    ],
  });
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const messageFindUnique = jest.fn();
  const messageFindMany = jest.fn();
  const transaction = jest
    .fn()
    .mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: { findMany: memberFindMany },
          message: { findMany: messageFindMany },
        }),
    );
  const prisma = {
    $transaction: transaction,
    conversationMember: { findMany: memberFindMany },
    conversation: { findUnique: conversationFindUnique },
    userBlock: { findFirst: blockFindFirst },
    message: { findUnique: messageFindUnique, findMany: messageFindMany },
  } as unknown as PrismaService;
  return {
    repository: new PrismaMessagesRepository(prisma),
    transaction,
    memberFindMany,
    conversationFindUnique,
    blockFindFirst,
    messageFindUnique,
    messageFindMany,
  };
}

function sendTransactionState(existing: unknown = null) {
  const conversationFindUnique = jest.fn().mockResolvedValue({
    type: 'DIRECT',
    members: [
      { userId: USER_ID, clearedAt: null },
      { userId: OTHER_USER_ID, clearedAt: null },
    ],
  });
  const blockFindFirst = jest.fn().mockResolvedValue(null);
  const messageFindUnique = jest.fn().mockResolvedValue(existing);
  const messageCreate = jest.fn().mockResolvedValue(rawMessage());
  const conversationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const memberUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
  const client = {
    conversationMember: {
      updateMany: memberUpdateMany,
    },
    userBlock: { findFirst: blockFindFirst },
    message: { findUnique: messageFindUnique, create: messageCreate },
    conversation: {
      findUnique: conversationFindUnique,
      updateMany: conversationUpdateMany,
    },
  };
  return {
    client,
    conversationFindUnique,
    blockFindFirst,
    messageFindUnique,
    messageCreate,
    conversationUpdateMany,
    memberUpdateMany,
  };
}

describe('PrismaMessagesRepository', () => {
  it('updates activity and unread state without unarchiving recipients', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'created',
      message: {
        ...rawMessage(),
        participantIds: [USER_ID, OTHER_USER_ID],
      },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(state.messageCreate).toHaveBeenCalledWith({
      data: {
        conversationId: CONVERSATION_ID,
        senderId: USER_ID,
        clientMessageId: CLIENT_MESSAGE_ID,
        kind: MessageKind.TEXT,
        text: 'Hello!',
        createdAt: NOW,
      },
      select: expect.any(Object),
    });
    expect(state.conversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: CONVERSATION_ID,
        lastActivityAt: { lt: NOW },
      },
      data: { lastActivityAt: NOW, updatedAt: NOW },
    });
    expect(state.memberUpdateMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        userId: { not: USER_ID },
      },
      data: { unreadCount: { increment: 1 } },
    });
  });

  it('places a new message after every member clear timestamp under clock skew', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    const createdAt = new Date(NOW.getTime() + 1);
    state.conversationFindUnique.mockResolvedValue({
      type: 'DIRECT',
      members: [
        { userId: USER_ID, clearedAt: NOW },
        { userId: OTHER_USER_ID, clearedAt: null },
      ],
    });
    state.messageCreate.mockResolvedValue(rawMessage({ createdAt }));
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'created',
      message: { createdAt },
    });
    expect(state.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdAt }),
      }),
    );
    expect(state.conversationUpdateMany).toHaveBeenCalledWith({
      where: {
        id: CONVERSATION_ID,
        lastActivityAt: { lt: createdAt },
      },
      data: { lastActivityAt: createdAt, updatedAt: createdAt },
    });
  });

  it('returns an existing identical message despite a later block', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(rawMessage());
    state.blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID },
    });
    expect(state.messageCreate).not.toHaveBeenCalled();
    expect(state.conversationUpdateMany).not.toHaveBeenCalled();
    expect(state.memberUpdateMany).not.toHaveBeenCalled();
    expect(state.blockFindFirst).not.toHaveBeenCalled();
  });

  it.each([
    rawMessage({ text: 'Different' }),
    rawMessage({ conversationId: OTHER_CONVERSATION_ID }),
  ])(
    'rejects an idempotency key reused with different data',
    async (existing) => {
      const { repository, transaction } = createRepository();
      const state = sendTransactionState(existing);
      transaction.mockImplementation(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

      await expect(repository.sendText(sendInput())).resolves.toEqual({
        status: 'idempotency-conflict',
      });
      expect(state.messageCreate).not.toHaveBeenCalled();
    },
  );

  it('returns the indistinguishable not-found result for a non-member', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    state.conversationFindUnique.mockResolvedValue({
      type: 'DIRECT',
      members: [{ userId: OTHER_USER_ID }],
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'conversation-not-found',
    });
    expect(state.messageFindUnique).not.toHaveBeenCalled();
    expect(state.messageCreate).not.toHaveBeenCalled();
  });

  it('conceals a direct conversation when either participant has blocked the other', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState();
    state.blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.sendText(sendInput())).resolves.toEqual({
      status: 'conversation-not-found',
    });
    expect(state.messageFindUnique).toHaveBeenCalled();
    expect(state.messageCreate).not.toHaveBeenCalled();
  });

  it('retries serializable write conflicts with a bounded attempt count', async () => {
    const { repository, transaction } = createRepository();
    const state = sendTransactionState(rawMessage());
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'existing',
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  it('reads the concurrent winner after a unique conflict', async () => {
    const { repository, transaction, blockFindFirst, messageFindUnique } =
      createRepository();
    transaction.mockRejectedValueOnce(knownRequestError('P2002'));
    messageFindUnique.mockResolvedValue(rawMessage());
    blockFindFirst.mockResolvedValue({ blockerId: OTHER_USER_ID });

    await expect(repository.sendText(sendInput())).resolves.toMatchObject({
      status: 'existing',
      message: { id: MESSAGE_ID },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(messageFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          senderId_clientMessageId: {
            senderId: USER_ID,
            clientMessageId: CLIENT_MESSAGE_ID,
          },
        },
      }),
    );
    expect(blockFindFirst).not.toHaveBeenCalled();
  });

  it('uses stable newest-first keyset pagination after membership validation', async () => {
    const { repository, transaction, memberFindMany, messageFindMany } =
      createRepository();
    memberFindMany.mockResolvedValue([
      { userId: USER_ID, clearedAt: null, clearedThroughMessageId: null },
      {
        userId: OTHER_USER_ID,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    ]);
    messageFindMany.mockResolvedValue([rawMessage()]);
    const cursor = {
      createdAt: new Date('2026-08-12T15:00:00.000Z'),
      id: MESSAGE_ID,
    };

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, cursor, 51),
    ).resolves.toMatchObject({ status: 'found' });
    expect(messageFindMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        AND: [
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          },
        ],
      },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  });

  it('only returns messages newer than the requesting member clear boundary', async () => {
    const { repository, memberFindMany, messageFindMany } = createRepository();
    memberFindMany.mockResolvedValue([
      {
        userId: USER_ID,
        clearedAt: NOW,
        clearedThroughMessageId: MESSAGE_ID,
      },
      {
        userId: OTHER_USER_ID,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    ]);
    messageFindMany.mockResolvedValue([]);

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, null, 51),
    ).resolves.toEqual({ status: 'found', messages: [] });
    expect(messageFindMany).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        AND: [
          {
            OR: [
              { createdAt: { gt: NOW } },
              { createdAt: NOW, id: { gt: MESSAGE_ID } },
            ],
          },
        ],
      },
      select: expect.any(Object),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 51,
    });
  });

  it('does not query history for a missing membership', async () => {
    const { repository, memberFindMany, messageFindMany } = createRepository();
    memberFindMany.mockResolvedValue([]);

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID, null, 51),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    expect(messageFindMany).not.toHaveBeenCalled();
  });

  it('sets unread count to zero and stores a read boundary transactionally', async () => {
    const { repository, transaction } = createRepository();
    const latestMessageAt = new Date('2026-08-12T16:01:00.000Z');
    const memberFindUnique = jest
      .fn()
      .mockResolvedValue({ conversationId: CONVERSATION_ID, lastReadAt: null });
    const messageFindFirst = jest
      .fn()
      .mockResolvedValue({ createdAt: latestMessageAt });
    const memberUpdate = jest.fn().mockResolvedValue({
      conversationId: CONVERSATION_ID,
      lastReadAt: latestMessageAt,
      unreadCount: 0,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: {
            findUnique: memberFindUnique,
            update: memberUpdate,
          },
          message: { findFirst: messageFindFirst },
        }),
    );

    await expect(
      repository.markRead(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({
      status: 'updated',
      state: {
        conversationId: CONVERSATION_ID,
        lastReadAt: latestMessageAt,
        unreadCount: 0,
      },
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
        },
      },
      data: { unreadCount: 0, lastReadAt: latestMessageAt },
      select: { conversationId: true, lastReadAt: true, unreadCount: true },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });

  it('sets only the requesting member clear boundary and resets unread state', async () => {
    const { repository, transaction } = createRepository();
    const latestMessageAt = new Date('2026-08-12T15:59:00.000Z');
    const memberFindUnique = jest.fn().mockResolvedValue({
      clearedAt: null,
      clearedThroughMessageId: null,
      unreadCount: 2,
    });
    const memberUpdate = jest.fn().mockResolvedValue({});
    const messageFindFirst = jest.fn().mockResolvedValue({
      id: MESSAGE_ID,
      createdAt: latestMessageAt,
    });
    const messageDeleteMany = jest.fn();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: {
            findUnique: memberFindUnique,
            update: memberUpdate,
          },
          message: {
            findFirst: messageFindFirst,
            deleteMany: messageDeleteMany,
          },
        }),
    );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({
      status: 'cleared',
      conversationId: CONVERSATION_ID,
      userId: USER_ID,
      changed: true,
      clearedAt: latestMessageAt,
      clearedThroughMessageId: MESSAGE_ID,
      occurredAt: NOW,
    });
    expect(memberUpdate).toHaveBeenCalledWith({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
        },
      },
      data: {
        clearedAt: latestMessageAt,
        clearedThroughMessageId: MESSAGE_ID,
        unreadCount: 0,
      },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(messageDeleteMany).not.toHaveBeenCalled();
  });

  it('conceals a clear request when the caller is not a member', async () => {
    const { repository, transaction } = createRepository();
    const memberFindUnique = jest.fn().mockResolvedValue(null);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({ conversationMember: { findUnique: memberFindUnique } }),
    );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({ status: 'conversation-not-found' });
  });

  it('conceals a membership removed while clear is committing', async () => {
    const { repository, transaction } = createRepository();
    const memberFindUnique = jest.fn().mockResolvedValue({
      clearedAt: null,
      clearedThroughMessageId: null,
      unreadCount: 1,
    });
    const memberUpdate = jest
      .fn()
      .mockRejectedValue(knownRequestError('P2025'));
    const messageFindFirst = jest.fn().mockResolvedValue({
      id: MESSAGE_ID,
      createdAt: NOW,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation({
          conversationMember: {
            findUnique: memberFindUnique,
            update: memberUpdate,
          },
          message: { findFirst: messageFindFirst },
        }),
    );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toEqual({ status: 'conversation-not-found' });
  });

  it('retries a clear after a serializable write conflict', async () => {
    const { repository, transaction } = createRepository();
    const memberFindUnique = jest.fn().mockResolvedValue({
      clearedAt: NOW,
      clearedThroughMessageId: MESSAGE_ID,
      unreadCount: 0,
    });
    const messageFindFirst = jest.fn().mockResolvedValue({
      id: MESSAGE_ID,
      createdAt: NOW,
    });
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation({
            conversationMember: { findUnique: memberFindUnique },
            message: { findFirst: messageFindFirst },
          }),
      );

    await expect(
      repository.clearForMember(CONVERSATION_ID, USER_ID, NOW),
    ).resolves.toMatchObject({ status: 'cleared', changed: false });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
});

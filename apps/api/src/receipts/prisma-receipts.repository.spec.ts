import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { MarkReceiptThroughInput } from './receipts.repository';
import { PrismaReceiptsRepository } from './prisma-receipts.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-08-12T21:00:00.000Z');
const JOINED_AT = new Date('2026-08-12T19:00:00.000Z');
const BOUNDARY_AT = new Date('2026-08-12T20:30:00.000Z');

function input(
  overrides: Partial<MarkReceiptThroughInput> = {},
): MarkReceiptThroughInput {
  return {
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    throughMessageId: MESSAGE_ID,
    status: 'DELIVERED',
    now: NOW,
    ...overrides,
  };
}

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function rawQueryTransactionError(
  databaseCode: '40001' | '40P01',
): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Raw query failed', {
    clientVersion: '6.19.3',
    code: 'P2010',
    meta: { code: databaseCode, message: `SQLSTATE ${databaseCode}` },
  });
}

function transactionState() {
  const memberFindUnique = jest.fn().mockResolvedValue({
    joinedAt: JOINED_AT,
    lastReadAt: null,
    unreadCount: 3,
    receiptVersion: 0,
  });
  const memberFindMany = jest
    .fn()
    .mockResolvedValue([{ userId: USER_ID }, { userId: OTHER_USER_ID }]);
  const memberUpdate = jest.fn().mockResolvedValue({ receiptVersion: 1 });
  const boundaryFindFirst = jest
    .fn()
    .mockResolvedValue({ id: MESSAGE_ID, createdAt: BOUNDARY_AT });
  const receiptFindFirst = jest
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValue({
      messageId: MESSAGE_ID,
      deliveredAt: NOW,
      readAt: null,
      message: { createdAt: BOUNDARY_AT },
    });
  const messageCount = jest.fn().mockResolvedValue(0);
  const queryRaw = jest.fn().mockResolvedValue([{ messageId: MESSAGE_ID }]);
  const client = {
    conversationMember: {
      findUnique: memberFindUnique,
      findMany: memberFindMany,
      update: memberUpdate,
    },
    message: { findFirst: boundaryFindFirst, count: messageCount },
    messageReceipt: { findFirst: receiptFindFirst },
    $queryRaw: queryRaw,
  };
  return {
    client,
    memberFindUnique,
    memberFindMany,
    memberUpdate,
    boundaryFindFirst,
    receiptFindFirst,
    messageCount,
    queryRaw,
  };
}

function createRepository() {
  const transaction = jest.fn();
  const conversationFindFirst = jest.fn();
  const prisma = {
    $transaction: transaction,
    conversation: { findFirst: conversationFindFirst },
  } as unknown as PrismaService;
  return {
    repository: new PrismaReceiptsRepository(prisma),
    transaction,
    conversationFindFirst,
  };
}

function sqlText(queryRaw: jest.Mock): string {
  const sql = queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
  return sql.strings?.join('?') ?? '';
}

describe('PrismaReceiptsRepository', () => {
  it('bulk marks only incoming messages through the delivery boundary', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.markThrough(input())).resolves.toEqual({
      status: 'updated',
      changed: true,
      receipt: {
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        status: 'DELIVERED',
        throughMessageId: MESSAGE_ID,
        at: NOW,
        version: 1,
        delivered: { messageId: MESSAGE_ID, at: NOW },
        read: null,
        unreadCount: 3,
        participantIds: [USER_ID, OTHER_USER_ID],
      },
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(state.boundaryFindFirst).toHaveBeenCalledWith({
      where: {
        id: MESSAGE_ID,
        conversationId: CONVERSATION_ID,
        senderId: { not: USER_ID },
        createdAt: { gte: JOINED_AT },
      },
      select: { id: true, createdAt: true },
    });
    expect(sqlText(state.queryRaw)).toContain('m."sender_id" <> ?::uuid');
    expect(sqlText(state.queryRaw)).toContain(
      'ON CONFLICT ("message_id", "user_id") DO NOTHING',
    );
  });

  it('makes read imply delivery and reconciles unread state atomically', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    const earlierDelivery = new Date('2026-08-12T20:45:00.000Z');
    state.receiptFindFirst
      .mockReset()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({
        messageId: MESSAGE_ID,
        deliveredAt: earlierDelivery,
        readAt: NOW,
        message: { createdAt: BOUNDARY_AT },
      });
    state.messageCount.mockResolvedValue(1);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(
      repository.markThrough(input({ status: 'READ' })),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      receipt: { status: 'READ', unreadCount: 1, at: NOW },
    });
    expect(sqlText(state.queryRaw)).toContain('"delivered_at", "read_at"');
    expect(sqlText(state.queryRaw)).toContain('GREATEST(');
    expect(sqlText(state.queryRaw)).toContain(
      'WHERE "message_receipts"."read_at" IS NULL',
    );
    expect(state.messageCount).toHaveBeenCalledWith({
      where: {
        conversationId: CONVERSATION_ID,
        senderId: { not: USER_ID },
        createdAt: { gte: JOINED_AT },
        receipts: { none: { userId: USER_ID, readAt: { not: null } } },
      },
    });
    expect(state.memberUpdate).toHaveBeenCalledWith({
      where: {
        conversationId_userId: {
          conversationId: CONVERSATION_ID,
          userId: USER_ID,
        },
      },
      data: {
        unreadCount: 1,
        lastReadAt: NOW,
        receiptVersion: { increment: 1 },
      },
      select: { receiptVersion: true },
    });
  });

  it('preserves the first transition timestamp and suppresses replay events', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    const firstDeliveredAt = new Date('2026-08-12T20:00:00.000Z');
    state.queryRaw.mockResolvedValue([]);
    state.receiptFindFirst.mockReset().mockResolvedValue({
      messageId: MESSAGE_ID,
      deliveredAt: firstDeliveredAt,
      readAt: null,
      message: { createdAt: BOUNDARY_AT },
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.markThrough(input())).resolves.toMatchObject({
      status: 'updated',
      changed: false,
      receipt: { at: firstDeliveredAt },
    });
  });

  it('does not advance the version when an older row is newly backfilled', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    const newerMessageId = '55555555-5555-4555-8555-555555555555';
    const newerCreatedAt = new Date('2026-08-12T20:45:00.000Z');
    state.receiptFindFirst.mockReset().mockResolvedValue({
      messageId: newerMessageId,
      deliveredAt: NOW,
      readAt: null,
      message: { createdAt: newerCreatedAt },
    });
    // The SQL write can still repair a missing older per-message receipt. It
    // must not publish or version-bump an unchanged effective frontier.
    state.queryRaw.mockResolvedValue([{ messageId: MESSAGE_ID }]);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.markThrough(input())).resolves.toMatchObject({
      status: 'updated',
      changed: false,
      receipt: { throughMessageId: newerMessageId, version: 0 },
    });
    expect(state.memberUpdate).not.toHaveBeenCalled();
  });

  it.each(['membership', 'boundary'] as const)(
    'returns indistinguishable not-found and performs no write for missing %s',
    async (missing) => {
      const { repository, transaction } = createRepository();
      const state = transactionState();
      if (missing === 'membership')
        state.memberFindUnique.mockResolvedValue(null);
      if (missing === 'boundary')
        state.boundaryFindFirst.mockResolvedValue(null);
      transaction.mockImplementation(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

      await expect(repository.markThrough(input())).resolves.toEqual({
        status: 'conversation-not-found',
      });
      expect(state.queryRaw).not.toHaveBeenCalled();
    },
  );

  it('retries serializable conflicts with a bounded attempt count', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

    await expect(repository.markThrough(input())).resolves.toMatchObject({
      status: 'updated',
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it.each(['40001', '40P01'] as const)(
    'retries raw-query transaction SQLSTATE %s',
    async (databaseCode) => {
      const { repository, transaction } = createRepository();
      const state = transactionState();
      transaction
        .mockRejectedValueOnce(rawQueryTransactionError(databaseCode))
        .mockImplementationOnce(
          async (operation: (client: unknown) => Promise<unknown>) =>
            operation(state.client),
        );

      await expect(repository.markThrough(input())).resolves.toMatchObject({
        status: 'updated',
      });
      expect(transaction).toHaveBeenCalledTimes(2);
    },
  );

  it('aggregates stable participant frontiers after membership validation', async () => {
    const { repository, conversationFindFirst } = createRepository();
    const newestAt = new Date('2026-08-12T20:30:00.000Z');
    const olderAt = new Date('2026-08-12T20:00:00.000Z');
    conversationFindFirst.mockResolvedValue({
      members: [
        {
          userId: USER_ID,
          receiptVersion: 0,
          messageReceipts: [],
        },
        {
          userId: OTHER_USER_ID,
          receiptVersion: 2,
          messageReceipts: [
            {
              messageId: MESSAGE_ID,
              deliveredAt: newestAt,
              readAt: null,
              message: { createdAt: newestAt },
            },
            {
              messageId: '44444444-4444-4444-8444-444444444443',
              deliveredAt: olderAt,
              readAt: olderAt,
              message: { createdAt: olderAt },
            },
          ],
        },
      ],
    });

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID),
    ).resolves.toEqual({
      status: 'found',
      conversationId: CONVERSATION_ID,
      frontiers: [
        { userId: USER_ID, version: 0, delivered: null, read: null },
        {
          userId: OTHER_USER_ID,
          version: 2,
          delivered: { messageId: MESSAGE_ID, at: newestAt },
          read: {
            messageId: '44444444-4444-4444-8444-444444444443',
            at: olderAt,
          },
        },
      ],
    });
  });

  it('does not expose receipt state to a non-member', async () => {
    const { repository, conversationFindFirst } = createRepository();
    conversationFindFirst.mockResolvedValue(null);

    await expect(
      repository.listForMember(CONVERSATION_ID, USER_ID),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    expect(conversationFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: CONVERSATION_ID,
          members: { some: { userId: USER_ID } },
        },
      }),
    );
  });
});

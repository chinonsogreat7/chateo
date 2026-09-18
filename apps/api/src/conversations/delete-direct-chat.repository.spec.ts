import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaConversationsRepository } from './prisma-conversations.repository';

const USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CHAT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const NOW = new Date('2026-09-18T10:00:00Z');
const BEFORE = new Date('2026-09-18T09:00:00Z');

function setup(
  member: unknown = {
    deletedAt: null,
    clearedAt: null,
    clearedThroughMessageId: null,
    conversation: { type: 'DIRECT' },
  },
) {
  const findUnique = jest.fn().mockResolvedValue(member);
  const findFirst = jest
    .fn()
    .mockResolvedValue({ id: MESSAGE, createdAt: BEFORE });
  const update = jest.fn().mockResolvedValue({});
  const findMany = jest.fn().mockResolvedValue([]);
  const client = {
    conversationMember: { findUnique, update },
    message: { findFirst },
  };
  const transaction = jest.fn(
    async (operation: (tx: typeof client) => Promise<unknown>) =>
      operation(client),
  );
  const repository = new PrismaConversationsRepository({
    $transaction: transaction,
    conversation: { findMany },
  } as unknown as PrismaService);
  return { repository, findUnique, findFirst, update, transaction, findMany };
}

describe('Delete direct chat for me persistence', () => {
  it('atomically hides only the caller and advances the history boundary without deleting data', async () => {
    const state = setup();
    await expect(
      state.repository.deleteDirectForMember(
        CHAT.toUpperCase(),
        USER.toUpperCase(),
        NOW,
      ),
    ).resolves.toEqual({
      status: 'deleted',
      conversationId: CHAT,
      userId: USER,
      changed: true,
      deletedAt: NOW,
      clearedAt: BEFORE,
      clearedThroughMessageId: MESSAGE,
      occurredAt: NOW,
    });
    expect(state.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(state.update).toHaveBeenCalledWith({
      where: { conversationId_userId: { conversationId: CHAT, userId: USER } },
      data: {
        deletedAt: NOW,
        clearedAt: BEFORE,
        clearedThroughMessageId: MESSAGE,
        unreadCount: 0,
        archivedAt: null,
        pinnedAt: null,
        favoritedAt: null,
      },
    });
    expect(state.findFirst).toHaveBeenCalledWith({
      where: { conversationId: CHAT },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  });

  it('returns the original timestamp and boundary on an already-hidden retry', async () => {
    const state = setup({
      deletedAt: BEFORE,
      clearedAt: BEFORE,
      clearedThroughMessageId: MESSAGE,
      conversation: { type: 'DIRECT' },
    });
    await expect(
      state.repository.deleteDirectForMember(CHAT, USER, NOW),
    ).resolves.toMatchObject({
      changed: false,
      deletedAt: BEFORE,
      clearedThroughMessageId: MESSAGE,
    });
    expect(state.findFirst).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'conversation-not-found'],
    [{ conversation: { type: 'GROUP' } }, 'not-direct'],
  ])(
    'rejects unsupported access without any writes (%s)',
    async (member, status) => {
      const state = setup(member);
      await expect(
        state.repository.deleteDirectForMember(CHAT, USER, NOW),
      ).resolves.toEqual({ status });
      expect(state.update).not.toHaveBeenCalled();
      expect(state.findFirst).not.toHaveBeenCalled();
    },
  );

  it('can hide an empty direct chat', async () => {
    const state = setup();
    state.findFirst.mockResolvedValue(null);
    await expect(
      state.repository.deleteDirectForMember(CHAT, USER, NOW),
    ).resolves.toMatchObject({
      changed: true,
      deletedAt: NOW,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
  });

  it('never moves an existing clear boundary backwards', async () => {
    const state = setup({
      deletedAt: null,
      clearedAt: NOW,
      clearedThroughMessageId: MESSAGE,
      conversation: { type: 'DIRECT' },
    });
    await expect(
      state.repository.deleteDirectForMember(CHAT, USER, NOW),
    ).resolves.toMatchObject({
      clearedAt: NOW,
      clearedThroughMessageId: MESSAGE,
    });
  });

  it('retries a serialization conflict', async () => {
    const state = setup();
    state.transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('race', {
        code: 'P2034',
        clientVersion: '6.19.3',
      }),
    );
    await expect(
      state.repository.deleteDirectForMember(CHAT, USER, NOW),
    ).resolves.toMatchObject({ changed: true });
    expect(state.transaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'filters hidden chats before pagination (archived=%s favorites=%s)',
    async (archived, favorites) => {
      const state = setup();
      await state.repository.listForUser(USER, null, 10, archived, favorites);
      for (const [query] of state.findMany.mock.calls as Array<
        [{ where: unknown }]
      >) {
        expect(query.where).toMatchObject({
          members: { some: { userId: USER, deletedAt: null } },
        });
      }
      expect(state.findMany).toHaveBeenCalledTimes(2);
    },
  );
});

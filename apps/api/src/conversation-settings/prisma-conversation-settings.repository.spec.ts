import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { UpdateConversationSettingsInput } from './conversation-settings.repository';
import { PrismaConversationSettingsRepository } from './prisma-conversation-settings.repository';

const USER_ID = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const NORMALIZED_USER_ID = USER_ID.toLowerCase();
const CONVERSATION_ID = 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB';
const NORMALIZED_CONVERSATION_ID = CONVERSATION_ID.toLowerCase();
const NOW = new Date('2026-09-03T17:00:00.000Z');
const MUTED_AT = new Date('2026-09-02T10:00:00.000Z');
const PINNED_AT = new Date('2026-09-03T08:00:00.000Z');

function input(
  overrides: Partial<UpdateConversationSettingsInput> = {},
): UpdateConversationSettingsInput {
  return {
    conversationId: CONVERSATION_ID,
    userId: USER_ID,
    archived: true,
    muted: false,
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

function transactionState() {
  const findUnique = jest.fn().mockResolvedValue({
    conversationId: NORMALIZED_CONVERSATION_ID,
    archivedAt: null,
    mutedAt: MUTED_AT,
    pinnedAt: PINNED_AT,
  });
  const update = jest.fn().mockResolvedValue({
    conversationId: NORMALIZED_CONVERSATION_ID,
    archivedAt: NOW,
    mutedAt: null,
    pinnedAt: PINNED_AT,
  });
  return {
    client: { conversationMember: { findUnique, update } },
    findUnique,
    update,
  };
}

function createRepository() {
  const transaction = jest.fn();
  const prisma = { $transaction: transaction } as unknown as PrismaService;
  return {
    repository: new PrismaConversationSettingsRepository(prisma),
    transaction,
  };
}

describe('PrismaConversationSettingsRepository', () => {
  it('updates requested timestamps while preserving omitted settings', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.updateForMember(input())).resolves.toEqual({
      status: 'updated',
      changed: true,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: NOW,
        mutedAt: null,
        pinnedAt: PINNED_AT,
      },
    });
    expect(state.findUnique).toHaveBeenCalledWith({
      where: {
        conversationId_userId: {
          conversationId: NORMALIZED_CONVERSATION_ID,
          userId: NORMALIZED_USER_ID,
        },
      },
      select: {
        conversationId: true,
        archivedAt: true,
        mutedAt: true,
        pinnedAt: true,
      },
    });
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { archivedAt: NOW, mutedAt: null },
      }),
    );
  });

  it('preserves the original timestamp on an idempotent replay', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.findUnique.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: NOW,
      mutedAt: null,
      pinnedAt: PINNED_AT,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(
      repository.updateForMember(
        input({ archived: true, muted: undefined, pinned: true }),
      ),
    ).resolves.toEqual({
      status: 'updated',
      changed: false,
      settings: {
        conversationId: NORMALIZED_CONVERSATION_ID,
        archivedAt: NOW,
        mutedAt: null,
        pinnedAt: PINNED_AT,
      },
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('requires an exact conversation membership before updating', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.findUnique.mockResolvedValue(null);
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.updateForMember(input())).resolves.toEqual({
      status: 'conversation-not-found',
    });
    expect(state.update).not.toHaveBeenCalled();
  });

  it('maps a membership deleted during the transaction to not found', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.update.mockRejectedValue(knownRequestError('P2025'));
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(repository.updateForMember(input())).resolves.toEqual({
      status: 'conversation-not-found',
    });
  });

  it('retries serialization conflicts with a bounded attempt count', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    transaction
      .mockRejectedValueOnce(knownRequestError('P2034'))
      .mockImplementationOnce(
        async (operation: (client: unknown) => Promise<unknown>) =>
          operation(state.client),
      );

    await expect(repository.updateForMember(input())).resolves.toMatchObject({
      status: 'updated',
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  });
});

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
const MUTED_UNTIL = new Date('2026-09-04T10:00:00.000Z');
const PINNED_AT = new Date('2026-09-03T08:00:00.000Z');
const FAVORITED_AT = new Date('2026-09-03T09:00:00.000Z');

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
    mutedUntil: MUTED_UNTIL,
    pinnedAt: PINNED_AT,
    favoritedAt: null,
    clearedAt: null,
    clearedThroughMessageId: null,
  });
  const update = jest.fn().mockResolvedValue({
    conversationId: NORMALIZED_CONVERSATION_ID,
    archivedAt: NOW,
    mutedAt: null,
    mutedUntil: null,
    pinnedAt: PINNED_AT,
    favoritedAt: null,
    clearedAt: null,
    clearedThroughMessageId: null,
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
        mutedUntil: null,
        pinnedAt: PINNED_AT,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
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
        mutedUntil: true,
        pinnedAt: true,
        favoritedAt: true,
        clearedAt: true,
        clearedThroughMessageId: true,
      },
    });
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { archivedAt: NOW, mutedAt: null, mutedUntil: null },
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
      mutedUntil: null,
      pinnedAt: PINNED_AT,
      favoritedAt: FAVORITED_AT,
      clearedAt: null,
      clearedThroughMessageId: null,
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
        mutedUntil: null,
        pinnedAt: PINNED_AT,
        favoritedAt: FAVORITED_AT,
        clearedAt: null,
        clearedThroughMessageId: null,
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

  it('sets a finite mute expiry and restarts the mute timestamp', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.update.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: NOW,
      mutedUntil: MUTED_UNTIL,
      pinnedAt: PINNED_AT,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await expect(
      repository.updateForMember(
        input({
          archived: undefined,
          muted: true,
          mutedUntil: MUTED_UNTIL,
        }),
      ),
    ).resolves.toMatchObject({ status: 'updated', changed: false });
    expect(state.update).not.toHaveBeenCalled();

    const refreshedUntil = new Date(MUTED_UNTIL.getTime() + 1_000);
    state.findUnique.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: MUTED_AT,
      mutedUntil: MUTED_UNTIL,
      pinnedAt: PINNED_AT,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    await repository.updateForMember(
      input({
        archived: undefined,
        muted: true,
        mutedUntil: refreshedUntil,
      }),
    );
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { mutedAt: NOW, mutedUntil: refreshedUntil },
      }),
    );
  });

  it('changes a finite mute to always without changing its original start', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.update.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: MUTED_AT,
      mutedUntil: null,
      pinnedAt: PINNED_AT,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await repository.updateForMember(
      input({ archived: undefined, muted: true, mutedUntil: null }),
    );

    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mutedUntil: null } }),
    );
  });

  it('starts a fresh timestamp when an expired finite mute becomes always', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.findUnique.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: MUTED_AT,
      mutedUntil: new Date(NOW.getTime() - 1),
      pinnedAt: PINNED_AT,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    state.update.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: NOW,
      mutedUntil: null,
      pinnedAt: PINNED_AT,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await repository.updateForMember(
      input({ archived: undefined, muted: true, mutedUntil: null }),
    );

    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mutedAt: NOW, mutedUntil: null } }),
    );
  });

  it('timestamps favorite once and clears it when disabled', async () => {
    const { repository, transaction } = createRepository();
    const state = transactionState();
    state.findUnique.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    state.update.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      favoritedAt: NOW,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    transaction.mockImplementation(
      async (operation: (client: unknown) => Promise<unknown>) =>
        operation(state.client),
    );

    await repository.updateForMember(
      input({ archived: undefined, muted: undefined, favorited: true }),
    );
    expect(state.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { favoritedAt: NOW } }),
    );

    state.findUnique.mockResolvedValue({
      conversationId: NORMALIZED_CONVERSATION_ID,
      archivedAt: null,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      favoritedAt: FAVORITED_AT,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    await repository.updateForMember(
      input({ archived: undefined, muted: undefined, favorited: false }),
    );
    expect(state.update).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { favoritedAt: null } }),
    );
  });
});

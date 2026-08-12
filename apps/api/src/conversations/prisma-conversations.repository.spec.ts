import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaConversationsRepository } from './prisma-conversations.repository';

const USER_ID = '22222222-2222-4222-8222-222222222222';
const PARTICIPANT_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-08-12T12:00:00.000Z');

function rawConversation() {
  return {
    id: CONVERSATION_ID,
    type: 'DIRECT',
    directUserOneId: PARTICIPANT_ID,
    directUserTwoId: USER_ID,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
    members: [
      {
        conversationId: CONVERSATION_ID,
        userId: USER_ID,
        joinedAt: NOW,
        user: { id: USER_ID, displayName: 'Current User', avatarUrl: null },
      },
      {
        conversationId: CONVERSATION_ID,
        userId: PARTICIPANT_ID,
        joinedAt: NOW,
        user: {
          id: PARTICIPANT_ID,
          displayName: 'Ada Okafor',
          avatarUrl: null,
        },
      },
    ],
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
  const prisma = {
    $transaction: transaction,
    conversation: { findUnique, findMany, findFirst },
  } as unknown as PrismaService;
  return {
    repository: new PrismaConversationsRepository(prisma),
    transaction,
    findUnique,
    findMany,
    findFirst,
  };
}

function successfulTransaction(existing: unknown = null) {
  const findUnique = jest.fn().mockResolvedValue(existing);
  const participantFindUnique = jest
    .fn()
    .mockResolvedValue({ id: PARTICIPANT_ID });
  const create = jest.fn().mockResolvedValue(rawConversation());
  const client = {
    conversation: { findUnique, create },
    user: { findUnique: participantFindUnique },
  };
  return { client, findUnique, participantFindUnique, create };
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

  it('uses stable keyset pagination scoped to conversation membership', async () => {
    const { repository, findMany } = createRepository();
    findMany.mockResolvedValue([rawConversation()]);
    const cursor = {
      lastActivityAt: new Date('2026-08-12T11:00:00.000Z'),
      id: CONVERSATION_ID,
    };

    await repository.listForUser(USER_ID, cursor, 21);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          members: { some: { userId: USER_ID } },
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
  });

  it('scopes detail reads to a member and selects no phone numbers', async () => {
    const { repository, findFirst } = createRepository();
    findFirst.mockResolvedValue(rawConversation());

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
    expect(JSON.stringify(findFirst.mock.calls[0])).not.toContain(
      'phoneNumber',
    );
  });
});

import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaBlocksRepository } from './prisma-blocks.repository';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-03T10:00:00.000Z');

function knownRequestError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Prisma error ${code}`, {
    clientVersion: '6.19.3',
    code,
  });
}

function createRepository() {
  const userFindUnique = jest.fn();
  const blockFindMany = jest.fn();
  const blockFindFirst = jest.fn();
  const blockUpsert = jest.fn();
  const blockDeleteMany = jest.fn();
  const prisma = {
    user: { findUnique: userFindUnique },
    userBlock: {
      findMany: blockFindMany,
      findFirst: blockFindFirst,
      upsert: blockUpsert,
      deleteMany: blockDeleteMany,
    },
  } as unknown as PrismaService;

  return {
    repository: new PrismaBlocksRepository(prisma),
    userFindUnique,
    blockFindMany,
    blockFindFirst,
    blockUpsert,
    blockDeleteMany,
  };
}

describe('PrismaBlocksRepository', () => {
  it('lists blocks with a public-user projection and stable ordering', async () => {
    const { repository, blockFindMany } = createRepository();
    blockFindMany.mockResolvedValue([
      {
        createdAt: NOW,
        blocked: {
          id: TARGET_ID,
          displayName: 'Ada Okafor',
          avatarUrl: null,
        },
      },
    ]);

    await expect(repository.listForUser(USER_ID)).resolves.toEqual([
      {
        blockedAt: NOW,
        user: {
          id: TARGET_ID,
          displayName: 'Ada Okafor',
          avatarUrl: null,
        },
      },
    ]);
    expect(blockFindMany).toHaveBeenCalledWith({
      where: { blockerId: USER_ID },
      select: {
        createdAt: true,
        blocked: {
          select: { id: true, displayName: true, avatarUrl: true },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { blockedId: 'asc' }],
    });
  });

  it('upserts a block so repeated requests preserve the original timestamp', async () => {
    const { repository, userFindUnique, blockUpsert } = createRepository();
    const publicUser = {
      id: TARGET_ID,
      displayName: 'Ada Okafor',
      avatarUrl: null,
    };
    userFindUnique.mockResolvedValue(publicUser);
    blockUpsert.mockResolvedValue({ createdAt: NOW });

    await expect(repository.block(USER_ID, TARGET_ID)).resolves.toEqual({
      status: 'blocked',
      block: { user: publicUser, blockedAt: NOW },
    });
    expect(blockUpsert).toHaveBeenCalledWith({
      where: {
        blockerId_blockedId: { blockerId: USER_ID, blockedId: TARGET_ID },
      },
      create: { blockerId: USER_ID, blockedId: TARGET_ID },
      update: {},
      select: { createdAt: true },
    });
  });

  it('does not write when the block target does not exist', async () => {
    const { repository, userFindUnique, blockUpsert } = createRepository();
    userFindUnique.mockResolvedValue(null);

    await expect(repository.block(USER_ID, TARGET_ID)).resolves.toEqual({
      status: 'user-not-found',
    });
    expect(blockUpsert).not.toHaveBeenCalled();
  });

  it('maps a delete race to the same missing-user result', async () => {
    const { repository, userFindUnique, blockUpsert } = createRepository();
    userFindUnique.mockResolvedValue({
      id: TARGET_ID,
      displayName: null,
      avatarUrl: null,
    });
    blockUpsert.mockRejectedValue(knownRequestError('P2003'));

    await expect(repository.block(USER_ID, TARGET_ID)).resolves.toEqual({
      status: 'user-not-found',
    });
  });

  it('uses deleteMany to make unblocking an absent block idempotent', async () => {
    const { repository, blockDeleteMany } = createRepository();
    blockDeleteMany.mockResolvedValue({ count: 0 });

    await expect(
      repository.unblock(USER_ID, TARGET_ID),
    ).resolves.toBeUndefined();
    expect(blockDeleteMany).toHaveBeenCalledWith({
      where: { blockerId: USER_ID, blockedId: TARGET_ID },
    });
  });

  it('checks both block directions without selecting user data', async () => {
    const { repository, blockFindFirst } = createRepository();
    blockFindFirst.mockResolvedValue({ blockerId: TARGET_ID });

    await expect(repository.hasBlockBetween(USER_ID, TARGET_ID)).resolves.toBe(
      true,
    );
    expect(blockFindFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { blockerId: USER_ID, blockedId: TARGET_ID },
          { blockerId: TARGET_ID, blockedId: USER_ID },
        ],
      },
      select: { blockerId: true },
    });
  });
});

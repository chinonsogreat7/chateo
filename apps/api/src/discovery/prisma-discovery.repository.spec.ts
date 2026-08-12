import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { PrismaDiscoveryRepository } from './prisma-discovery.repository';

function createRepository() {
  const findMany = jest.fn().mockResolvedValue([]);
  const repository = new PrismaDiscoveryRepository({
    user: { findMany },
  } as unknown as PrismaService);
  return { findMany, repository };
}

const currentUserId = 'b5a64434-dbc8-4c61-a535-6c93e49ca6bc';

describe('PrismaDiscoveryRepository', () => {
  it('matches only exact submitted phone numbers and excludes the caller', async () => {
    const { findMany, repository } = createRepository();

    await repository.matchContacts({
      currentUserId,
      phoneNumbers: ['+2348012345678', '+2348098765432'],
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { not: currentUserId },
        phoneNumber: { in: ['+2348012345678', '+2348098765432'] },
      },
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
        phoneNumber: true,
      },
    });
  });

  it('does not query the database for an empty contacts batch', async () => {
    const { findMany, repository } = createRepository();

    await expect(
      repository.matchContacts({ currentUserId, phoneNumbers: [] }),
    ).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('searches completed profiles by display name using a descending keyset', async () => {
    const { findMany, repository } = createRepository();
    const createdAt = new Date('2026-08-12T09:00:00.000Z');
    const id = '4eb7262d-7a31-45a3-a03a-2be8a1126984';

    await repository.searchUsers({
      currentUserId,
      normalizedQuery: 'ada',
      databaseQuery: 'ada',
      take: 21,
      after: { createdAt, id },
    });

    expect(findMany).toHaveBeenCalledWith({
      where: {
        id: { not: currentUserId },
        profileCompletedAt: { not: null },
        displayName: {
          not: null,
          contains: 'ada',
          mode: Prisma.QueryMode.insensitive,
        },
        OR: [{ createdAt: { lt: createdAt } }, { createdAt, id: { lt: id } }],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
      select: {
        id: true,
        displayName: true,
        avatarUrl: true,
        createdAt: true,
      },
    });
  });
});

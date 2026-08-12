import { PrismaService } from '../src/database/prisma.service';
import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
import { PrismaDiscoveryRepository } from '../src/discovery/prisma-discovery.repository';

const USER_ONE_ID = '00000000-0000-4000-8000-000000000301';
const USER_TWO_ID = '00000000-0000-4000-8000-000000000302';
const USER_THREE_ID = '00000000-0000-4000-8000-000000000303';
const INCOMPLETE_USER_ID = '00000000-0000-4000-8000-000000000304';
const USER_IDS = [USER_ONE_ID, USER_TWO_ID, USER_THREE_ID, INCOMPLETE_USER_ID];
const NOW = new Date('2026-08-12T14:00:00.000Z');

describe('Prisma direct-conversation concurrency', () => {
  const prisma = new PrismaService();
  const repository = new PrismaConversationsRepository(prisma);
  const discoveryRepository = new PrismaDiscoveryRepository(prisma);

  beforeAll(async () => {
    await cleanup();
    await prisma.user.createMany({
      data: [
        {
          id: USER_ONE_ID,
          phoneNumber: '+12025550121',
          phoneVerifiedAt: NOW,
          displayName: 'Integration Alice',
          profileCompletedAt: NOW,
        },
        {
          id: USER_TWO_ID,
          phoneNumber: '+12025550122',
          phoneVerifiedAt: NOW,
          displayName: 'Integration Bob',
          profileCompletedAt: NOW,
        },
        {
          id: USER_THREE_ID,
          phoneNumber: '+12025550123',
          phoneVerifiedAt: NOW,
          displayName: 'Integration Carol',
          profileCompletedAt: NOW,
        },
        {
          id: INCOMPLETE_USER_ID,
          phoneNumber: '+12025550124',
          phoneVerifiedAt: NOW,
          displayName: 'Integration Hidden',
          profileCompletedAt: null,
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it('converges concurrent reversed requests to one conversation and two members', async () => {
    const [forward, reversed] = await Promise.all([
      repository.createOrGetDirect(USER_ONE_ID, USER_TWO_ID, NOW),
      repository.createOrGetDirect(USER_TWO_ID, USER_ONE_ID, NOW),
    ]);

    expect(forward.status).not.toBe('participant-not-found');
    expect(reversed.status).not.toBe('participant-not-found');
    if (
      forward.status === 'participant-not-found' ||
      reversed.status === 'participant-not-found'
    ) {
      throw new Error('Seeded integration users were not found.');
    }
    expect(forward.conversation.id).toBe(reversed.conversation.id);

    const persisted = await prisma.conversation.findMany({
      where: {
        directUserOneId: USER_ONE_ID,
        directUserTwoId: USER_TWO_ID,
      },
      include: { members: true },
    });
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.members.map((member) => member.userId).sort()).toEqual(
      [USER_ONE_ID, USER_TWO_ID].sort(),
    );
  });

  it('uses PostgreSQL discovery semantics without exposing self or incomplete profiles', async () => {
    const matches = await discoveryRepository.matchContacts({
      currentUserId: USER_ONE_ID,
      phoneNumbers: ['+12025550121', '+12025550122', '+12025550124'],
    });
    expect(matches.map((match) => match.id).sort()).toEqual(
      [USER_TWO_ID, INCOMPLETE_USER_ID].sort(),
    );

    const searchResults = await discoveryRepository.searchUsers({
      currentUserId: USER_ONE_ID,
      normalizedQuery: 'integration',
      databaseQuery: 'integration',
      take: 10,
    });
    expect(searchResults.map((user) => user.id).sort()).toEqual(
      [USER_TWO_ID, USER_THREE_ID].sort(),
    );

    const phoneSearch = await discoveryRepository.searchUsers({
      currentUserId: USER_ONE_ID,
      normalizedQuery: '120255',
      databaseQuery: '120255',
      take: 10,
    });
    expect(phoneSearch).toEqual([]);
  });

  it('scopes real PostgreSQL list and detail reads to conversation members', async () => {
    const result = await repository.createOrGetDirect(
      USER_ONE_ID,
      USER_TWO_ID,
      NOW,
    );
    if (result.status === 'participant-not-found') {
      throw new Error('Seeded integration users were not found.');
    }

    await expect(
      repository.listForUser(USER_ONE_ID, null, 20),
    ).resolves.toHaveLength(1);
    await expect(
      repository.listForUser(USER_TWO_ID, null, 20),
    ).resolves.toHaveLength(1);
    await expect(
      repository.listForUser(USER_THREE_ID, null, 20),
    ).resolves.toEqual([]);
    await expect(
      repository.findForUser(result.conversation.id, USER_THREE_ID),
    ).resolves.toBeNull();
    await expect(
      repository.findForUser(result.conversation.id, USER_ONE_ID),
    ).resolves.toMatchObject({ id: result.conversation.id });
  });

  async function cleanup(): Promise<void> {
    await prisma.conversation.deleteMany({
      where: {
        OR: [
          { directUserOneId: { in: USER_IDS } },
          { directUserTwoId: { in: USER_IDS } },
        ],
      },
    });
    await prisma.authSession.deleteMany({
      where: { userId: { in: USER_IDS } },
    });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
  }
});

import { PrismaService } from '../src/database/prisma.service';
import { PrismaBlocksRepository } from '../src/blocks/prisma-blocks.repository';
import { PrismaConversationSettingsRepository } from '../src/conversation-settings/prisma-conversation-settings.repository';
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
  const blocksRepository = new PrismaBlocksRepository(prisma);
  const settingsRepository = new PrismaConversationSettingsRepository(prisma);

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

  it('persists groups, per-member settings, and bidirectional block policy', async () => {
    const created = await repository.createGroup({
      creatorId: USER_ONE_ID,
      name: 'Integration Study Group',
      avatarUrl: null,
      participantIds: [USER_TWO_ID, USER_THREE_ID],
      now: NOW,
    });
    expect(created).toMatchObject({
      status: 'created',
      conversation: {
        type: 'GROUP',
        role: 'OWNER',
        participants: expect.arrayContaining([
          expect.objectContaining({ id: USER_ONE_ID, role: 'OWNER' }),
          expect.objectContaining({ id: USER_TWO_ID, role: 'MEMBER' }),
          expect.objectContaining({ id: USER_THREE_ID, role: 'MEMBER' }),
        ]),
      },
    });
    if (created.status !== 'created') {
      throw new Error('Seeded group participants were not found.');
    }

    await expect(
      settingsRepository.updateForMember({
        conversationId: created.conversation.id,
        userId: USER_TWO_ID,
        archived: true,
        muted: true,
        pinned: true,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      settings: {
        archivedAt: NOW,
        mutedAt: NOW,
        pinnedAt: NOW,
      },
    });
    await expect(
      repository.listForUser(USER_TWO_ID, null, 20),
    ).resolves.not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.conversation.id }),
      ]),
    );
    await expect(
      repository.listForUser(USER_TWO_ID, null, 20, true),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.conversation.id,
          settings: {
            archivedAt: NOW,
            mutedAt: NOW,
            pinnedAt: NOW,
          },
        }),
      ]),
    );

    await expect(
      blocksRepository.block(USER_ONE_ID, USER_TWO_ID),
    ).resolves.toMatchObject({ status: 'blocked' });
    await expect(
      blocksRepository.hasBlockBetween(USER_TWO_ID, USER_ONE_ID),
    ).resolves.toBe(true);
    await expect(
      repository.createOrGetDirect(USER_TWO_ID, USER_ONE_ID, NOW),
    ).resolves.toEqual({ status: 'participant-not-found' });
    const hiddenSearch = await discoveryRepository.searchUsers({
      currentUserId: USER_TWO_ID,
      normalizedQuery: 'alice',
      databaseQuery: 'alice',
      take: 10,
    });
    expect(hiddenSearch).toEqual([]);
  });

  async function cleanup(): Promise<void> {
    await prisma.userBlock.deleteMany({
      where: {
        OR: [{ blockerId: { in: USER_IDS } }, { blockedId: { in: USER_IDS } }],
      },
    });
    await prisma.conversation.deleteMany({
      where: {
        OR: [
          { directUserOneId: { in: USER_IDS } },
          { directUserTwoId: { in: USER_IDS } },
          { createdById: { in: USER_IDS } },
        ],
      },
    });
    await prisma.authSession.deleteMany({
      where: { userId: { in: USER_IDS } },
    });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
  }
});

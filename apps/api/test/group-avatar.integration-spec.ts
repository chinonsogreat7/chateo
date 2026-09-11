import { randomUUID } from 'node:crypto';
import { MediaPurpose, MediaStatus, type Prisma } from '@prisma/client';
import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
import { PrismaService } from '../src/database/prisma.service';

const OWNER_ID = '00000000-0000-4000-8000-000000000801';
const MEMBER_ID = '00000000-0000-4000-8000-000000000802';
const USER_IDS = [OWNER_ID, MEMBER_ID];
const NOW = new Date('2026-09-09T12:00:00.000Z');

describe('Prisma verified group photos', () => {
  const prisma = new PrismaService();
  const repository = new PrismaConversationsRepository(prisma);

  async function cleanup(): Promise<void> {
    await prisma.conversation.deleteMany({
      where: { createdById: { in: USER_IDS } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { ownerId: { in: USER_IDS } },
    });
    await prisma.user.deleteMany({ where: { id: { in: USER_IDS } } });
  }

  beforeEach(async () => {
    await cleanup();
    await prisma.user.createMany({
      data: USER_IDS.map((id, index) => ({
        id,
        phoneNumber: `+1202555080${index + 1}`,
        phoneVerifiedAt: NOW,
        displayName: `Avatar Test ${index}`,
        profileCompletedAt: NOW,
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  function createAsset(
    overrides: Partial<Prisma.MediaAssetUncheckedCreateInput> = {},
  ) {
    const id = randomUUID();
    return prisma.mediaAsset.create({
      data: {
        id,
        ownerId: OWNER_ID,
        clientUploadId: randomUUID(),
        purpose: MediaPurpose.GROUP_AVATAR,
        status: MediaStatus.READY,
        uploadFingerprint: 'a'.repeat(64),
        cloudinaryPublicId: `integration/group-avatars/${id}`,
        resourceType: 'image',
        deliveryType: 'upload',
        format: 'jpg',
        mimeType: 'image/jpeg',
        byteSize: 1000,
        width: 640,
        height: 640,
        secureUrl: `https://res.cloudinary.com/classroom/image/upload/${id}.jpg`,
        completedAt: NOW,
        createdAt: NOW,
        expiresAt: new Date(NOW.getTime() + 600_000),
        ...overrides,
      },
    });
  }

  async function createGroup(avatarMediaId: string | null = null) {
    const result = await repository.createGroup({
      creatorId: OWNER_ID,
      name: 'Verified Photo Group',
      avatarMediaId,
      participantIds: [MEMBER_ID],
      now: NOW,
    });
    if (result.status !== 'created')
      throw new Error(`Unexpected group creation: ${result.status}`);
    return result.conversation;
  }

  it('creates a group with the verified reference, protects it, and detaches without deleting media', async () => {
    const asset = await createAsset();
    const group = await createGroup(asset.id);
    expect(group.avatarUrl).toBe(asset.secureUrl);
    await expect(
      prisma.conversation.findUnique({ where: { id: group.id } }),
    ).resolves.toMatchObject({
      avatarMediaId: asset.id,
      avatarUrl: asset.secureUrl,
    });
    await expect(
      prisma.mediaAsset.delete({ where: { id: asset.id } }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      repository.updateGroup({
        conversationId: group.id,
        actorId: OWNER_ID,
        avatarMediaId: null,
        now: NOW,
      }),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      conversation: { avatarUrl: null },
    });
    await expect(
      prisma.conversation.findUnique({ where: { id: group.id } }),
    ).resolves.toMatchObject({ avatarMediaId: null, avatarUrl: null });
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: asset.id } }),
    ).resolves.toMatchObject({ status: MediaStatus.READY });
  });

  it.each([
    ['foreign', { ownerId: MEMBER_ID }],
    ['pending', { status: MediaStatus.PENDING }],
    ['failed', { status: MediaStatus.FAILED }],
    ['deleted', { status: MediaStatus.DELETED }],
    ['soft-deleted', { deletedAt: NOW }],
    ['profile avatar', { purpose: MediaPurpose.PROFILE_AVATAR }],
    ['message image', { purpose: MediaPurpose.MESSAGE_ATTACHMENT }],
    ['audio', { resourceType: 'video', format: 'm4a', mimeType: 'audio/mp4' }],
    ['incomplete verification', { completedAt: null }],
    ['missing dimensions', { width: null }],
    ['insecure URL', { secureUrl: 'http://example.com/photo.jpg' }],
    ['missing URL', { secureUrl: null }],
  ] satisfies Array<[string, Partial<Prisma.MediaAssetUncheckedCreateInput>]>)(
    'rejects %s media for creation and updates without partial changes',
    async (_label, overrides) => {
      const asset = await createAsset(overrides);
      const group = await createGroup();
      await expect(
        repository.createGroup({
          creatorId: OWNER_ID,
          name: 'Rejected',
          avatarMediaId: asset.id,
          participantIds: [MEMBER_ID],
          now: NOW,
        }),
      ).resolves.toEqual({ status: 'avatar-unavailable' });
      await expect(
        repository.updateGroup({
          conversationId: group.id,
          actorId: OWNER_ID,
          name: 'Rejected',
          avatarMediaId: asset.id,
          now: NOW,
        }),
      ).resolves.toEqual({ status: 'avatar-unavailable' });
      expect(
        await prisma.conversation.count({ where: { createdById: OWNER_ID } }),
      ).toBe(1);
      await expect(
        prisma.conversation.findUnique({ where: { id: group.id } }),
      ).resolves.toMatchObject({
        name: 'Verified Photo Group',
        avatarMediaId: null,
        avatarUrl: null,
      });
    },
  );

  it('allows an admin to assign their own upload and converges concurrent retries', async () => {
    const asset = await createAsset({ ownerId: MEMBER_ID });
    const group = await createGroup();
    const input = {
      conversationId: group.id,
      actorId: MEMBER_ID,
      avatarMediaId: asset.id,
      now: NOW,
    };
    await expect(repository.updateGroup(input)).resolves.toEqual({
      status: 'forbidden',
    });
    await repository.updateGroupMemberRole({
      conversationId: group.id,
      actorId: OWNER_ID,
      memberId: MEMBER_ID,
      role: 'ADMIN',
      now: NOW,
    });
    const results = await Promise.all([
      repository.updateGroup(input),
      repository.updateGroup(input),
    ]);
    expect(results.every((result) => result.status === 'updated')).toBe(true);
    expect(
      results.filter((result) => result.status === 'updated' && result.changed),
    ).toHaveLength(1);
    await expect(
      repository.findForUser(group.id, OWNER_ID),
    ).resolves.toMatchObject({ avatarUrl: asset.secureUrl });
  });
});

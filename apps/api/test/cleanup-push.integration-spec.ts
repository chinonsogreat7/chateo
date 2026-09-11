import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaMediaCleanupRepository } from '../src/media/prisma-media-cleanup.repository';
import { PrismaMediaRepository } from '../src/media/prisma-media.repository';
import { PrismaMessagesRepository } from '../src/messages/prisma-messages.repository';
import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
import { PushRepository } from '../src/push/push.repository';

const OWNER = '00000000-0000-4000-8000-000000001101';
const RECIPIENT = '00000000-0000-4000-8000-000000001102';
const USERS = [OWNER, RECIPIENT];
const NOW = new Date('2026-09-11T12:00:00Z');
const OLD = new Date(NOW.getTime() - 3 * 86400000);

describe('PostgreSQL unused media and durable push', () => {
  const prisma = new PrismaService();
  const cleanup = new PrismaMediaCleanupRepository(prisma);
  const media = new PrismaMediaRepository(prisma);
  const pushes = new PushRepository(prisma);
  const conversations = new PrismaConversationsRepository(prisma);
  const messages = new PrismaMessagesRepository(
    prisma,
    new ConfigService({
      PUSH_NOTIFICATIONS_ENABLED: true,
      PUSH_OFFLINE_DELAY_SECONDS: 15,
    }),
  );
  const cleanupInput = (id: string) => ({
    id,
    now: NOW,
    signatureIssuedBefore: new Date(NOW.getTime() - 3900000),
    expiredBefore: NOW,
    unusedBefore: new Date(NOW.getTime() - 86400000),
  });
  async function removeFixtures() {
    await prisma.conversation.deleteMany({
      where: { createdById: { in: USERS } },
    });
    await prisma.user.updateMany({
      where: { id: { in: USERS } },
      data: { avatarMediaId: null, avatarUrl: null },
    });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: USERS } } });
    await prisma.user.deleteMany({ where: { id: { in: USERS } } });
  }
  beforeEach(async () => {
    await removeFixtures();
    await prisma.user.createMany({
      data: USERS.map((id, index) => ({
        id,
        phoneNumber: `+1202555110${index}`,
        phoneVerifiedAt: OLD,
        displayName: `Worker ${index}`,
        profileCompletedAt: OLD,
      })),
    });
  });
  afterAll(async () => {
    await removeFixtures();
    await prisma.$disconnect();
  });
  async function asset(
    purpose:
      | 'PROFILE_AVATAR'
      | 'GROUP_AVATAR'
      | 'MESSAGE_ATTACHMENT' = 'PROFILE_AVATAR',
  ) {
    const id = randomUUID();
    return prisma.mediaAsset.create({
      data: {
        id,
        ownerId: OWNER,
        clientUploadId: randomUUID(),
        purpose,
        status: 'READY',
        uploadFingerprint: 'a'.repeat(64),
        cloudinaryPublicId: `integration/${id}`,
        cloudinaryAssetId: randomUUID(),
        mimeType: 'image/jpeg',
        format: 'jpg',
        byteSize: 1000,
        width: 640,
        height: 480,
        secureUrl: `https://res.cloudinary.com/test/image/upload/${id}.jpg`,
        createdAt: OLD,
        expiresAt: new Date(OLD.getTime() + 600000),
        completedAt: OLD,
        unusedSince: OLD,
      },
    });
  }
  it('retains referenced/legacy avatars and gives replaced avatars a fresh observed grace period', async () => {
    const old = await asset();
    const next = await asset();
    await media.setProfileAvatar(OWNER, old.id);
    await expect(cleanup.claimUnusedReady(cleanupInput(old.id))).resolves.toBe(
      false,
    );
    await media.setProfileAvatar(OWNER, next.id);
    await expect(cleanup.claimUnusedReady(cleanupInput(old.id))).resolves.toBe(
      false,
    );
    await expect(
      prisma.mediaAsset.findUnique({ where: { id: old.id } }),
    ).resolves.toMatchObject({ unusedSince: NOW });
    const later = new Date(NOW.getTime() + 86400001);
    await expect(
      cleanup.claimUnusedReady({
        ...cleanupInput(old.id),
        now: later,
        unusedBefore: new Date(later.getTime() - 86400000),
      }),
    ).resolves.toBe(true);
    await expect(media.setProfileAvatar(OWNER, old.id)).resolves.toEqual({
      status: 'media-not-ready',
    });
    const legacy = await asset();
    await prisma.user.update({
      where: { id: RECIPIENT },
      data: { avatarUrl: legacy.secureUrl },
    });
    await expect(
      cleanup.claimUnusedReady(cleanupInput(legacy.id)),
    ).resolves.toBe(false);
  });
  it('serializes avatar adoption against cleanup so an assigned asset is never retired', async () => {
    const image = await asset();
    const [retired, assigned] = await Promise.all([
      cleanup.claimUnusedReady(cleanupInput(image.id)),
      media.setProfileAvatar(OWNER, image.id),
    ]);
    expect(retired && assigned.status === 'updated').toBe(false);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: OWNER } });
    const stored = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: image.id },
    });
    if (user.avatarMediaId === image.id) expect(stored.status).toBe('READY');
  });
  it('queues once per message/device, respects mute windows, survives refresh, and stops after logout', async () => {
    const sessionId = randomUUID();
    const familyId = randomUUID();
    const installation = randomUUID();
    const session = {
      id: sessionId,
      userId: RECIPIENT,
      familyId,
      tokenDigest: 'd'.repeat(64),
      expiresAt: new Date(NOW.getTime() + 86400000),
      lastUsedAt: NOW,
    };
    await prisma.authSession.create({ data: session });
    const body = {
      token: 'ExpoPushToken[integration1234567890]',
      platform: 'ios' as const,
    };
    await pushes.register(RECIPIENT, sessionId, installation, body, NOW);
    const group = await conversations.createGroup({
      creatorId: OWNER,
      name: 'Push test',
      participantIds: [RECIPIENT],
      avatarMediaId: null,
      now: OLD,
    });
    if (group.status !== 'created') throw new Error(group.status);
    const input = {
      senderId: OWNER,
      conversationId: group.conversation.id,
      clientMessageId: randomUUID(),
      text: 'Private text must not enter push payload',
      attachmentMediaIds: [],
      now: NOW,
    };
    const sends = await Promise.all([
      messages.send(input),
      messages.send(input),
    ]);
    expect(sends.map((send) => send.status).sort()).toEqual([
      'created',
      'existing',
    ]);
    await expect(
      prisma.pushNotification.count({ where: { deviceId: installation } }),
    ).resolves.toBe(1);
    const due = new Date(NOW.getTime() + 16000);
    const [left, right] = await Promise.all([
      pushes.claimDue(due),
      pushes.claimDue(due),
    ]);
    expect(left.length + right.length).toBe(1);
    const job = [...left, ...right][0]!;
    await expect(pushes.eligible(job, due)).resolves.toMatchObject({
      token: body.token,
      userId: RECIPIENT,
    });
    await prisma.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId: input.conversationId,
          userId: RECIPIENT,
        },
      },
      data: { mutedAt: NOW, mutedUntil: null },
    });
    await expect(pushes.eligible(job, due)).resolves.toBeNull();
    await messages.send({ ...input, clientMessageId: randomUUID() });
    await expect(
      prisma.pushNotification.count({ where: { deviceId: installation } }),
    ).resolves.toBe(1);
    await prisma.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId: input.conversationId,
          userId: RECIPIENT,
        },
      },
      data: { mutedUntil: NOW },
    });
    await prisma.authSession.update({
      where: { id: sessionId },
      data: { revokedAt: NOW, revokedReason: 'ROTATED' },
    });
    const rotated = randomUUID();
    await prisma.authSession.create({
      data: { ...session, id: rotated, tokenDigest: 'e'.repeat(64) },
    });
    await expect(pushes.eligible(job, due)).resolves.not.toBeNull();
    await messages.markRead(input.conversationId, RECIPIENT, due);
    await messages.send({
      ...input,
      clientMessageId: randomUUID(),
      now: new Date(due.getTime() + 1000),
    });
    await expect(
      prisma.pushNotification.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: 'SKIPPED',
      errorCode: 'Read',
      leaseToken: null,
    });
    await expect(pushes.ownsLease(job, due)).resolves.toBe(false);
    await expect(
      prisma.pushNotification.count({
        where: { deviceId: installation, status: 'PENDING' },
      }),
    ).resolves.toBe(1);
    await prisma.authSession.update({
      where: { id: rotated },
      data: { revokedAt: due, revokedReason: 'LOGOUT' },
    });
    await expect(pushes.eligible(job, due)).resolves.toBeNull();
  });
  it('protects group photos and permanently claimed message media from cleanup', async () => {
    const photo = await asset('GROUP_AVATAR');
    const group = await conversations.createGroup({
      creatorId: OWNER,
      name: 'Photo test',
      participantIds: [RECIPIENT],
      avatarMediaId: photo.id,
      now: OLD,
    });
    if (group.status !== 'created') throw new Error(group.status);
    await expect(
      cleanup.claimUnusedReady(cleanupInput(photo.id)),
    ).resolves.toBe(false);
    const attachment = await asset('MESSAGE_ATTACHMENT');
    const sent = await messages.send({
      senderId: OWNER,
      conversationId: group.conversation.id,
      clientMessageId: randomUUID(),
      text: null,
      attachmentMediaIds: [attachment.id],
      now: NOW,
    });
    if (sent.status !== 'created') throw new Error(sent.status);
    await messages.mutate({
      conversationId: group.conversation.id,
      actorId: OWNER,
      messageId: sent.message.id,
      mutation: { kind: 'delete' },
      now: NOW,
    });
    await expect(
      cleanup.claimUnusedReady(cleanupInput(attachment.id)),
    ).resolves.toBe(false);
  });
});

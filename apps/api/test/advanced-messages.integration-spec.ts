import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
import { PrismaMessagesRepository } from '../src/messages/prisma-messages.repository';
import type { SendMessageInput } from '../src/messages/messages.repository';

// The shared integration setup refuses non-test databases/schemas.
const OWNER = '00000000-0000-4000-8000-000000000901';
const MEMBER = '00000000-0000-4000-8000-000000000902';
const USERS = [OWNER, MEMBER];
const NOW = new Date('2026-09-09T12:00:00.000Z');

describe('Prisma advanced messaging persistence', () => {
  const prisma = new PrismaService();
  const messages = new PrismaMessagesRepository(prisma);
  const conversations = new PrismaConversationsRepository(prisma);
  let conversationId: string;

  async function cleanup() {
    await prisma.conversation.deleteMany({
      where: { createdById: { in: USERS } },
    });
    await prisma.mediaAsset.deleteMany({ where: { ownerId: { in: USERS } } });
    await prisma.user.deleteMany({ where: { id: { in: USERS } } });
  }
  beforeEach(async () => {
    await cleanup();
    await prisma.user.createMany({
      data: USERS.map((id, index) => ({
        id,
        phoneNumber: `+1202555090${index + 1}`,
        phoneVerifiedAt: NOW,
        displayName: `Advanced ${index}`,
        profileCompletedAt: NOW,
      })),
    });
    const result = await conversations.createGroup({
      creatorId: OWNER,
      name: 'Advanced messages',
      participantIds: [MEMBER],
      avatarMediaId: null,
      now: NOW,
    });
    if (result.status !== 'created') throw new Error(result.status);
    conversationId = result.conversation.id;
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  function sendInput(text = 'Lesson 50%_off') {
    return {
      conversationId,
      senderId: OWNER,
      clientMessageId: randomUUID(),
      text,
      attachmentMediaIds: [] as string[],
      now: NOW,
    };
  }
  async function createMessage(input: SendMessageInput = sendInput()) {
    const result = await messages.send(input);
    if (result.status !== 'created') throw new Error(result.status);
    return result.message;
  }

  it('arbitrates concurrent edits and reactions, preserves send retries and deletion placeholders', async () => {
    const input = sendInput();
    const message = await createMessage(input);
    const base = {
      conversationId,
      actorId: OWNER,
      messageId: message.id,
      now: NOW,
    };
    const edits = await Promise.all(
      ['Edited A', 'Edited B'].map((text) =>
        messages.mutate({
          ...base,
          mutation: { kind: 'edit', text, expectedVersion: 0 },
        }),
      ),
    );
    expect(edits.map((edit) => edit.status).sort()).toEqual([
      'updated',
      'version-conflict',
    ]);
    const reactions = await Promise.all(
      USERS.map((actorId) =>
        messages.mutate({
          ...base,
          actorId,
          mutation: { kind: 'reaction', emoji: '👍' },
        }),
      ),
    );
    expect(reactions.map((reaction) => reaction.status)).toEqual([
      'updated',
      'updated',
    ]);
    await expect(
      prisma.message.findUnique({
        where: { id: message.id },
        include: { reactions: true },
      }),
    ).resolves.toMatchObject({
      version: 3,
      reactions: expect.arrayContaining(
        USERS.map((userId) => expect.objectContaining({ userId, emoji: '👍' })),
      ),
    });
    await expect(messages.send(input)).resolves.toMatchObject({
      status: 'existing',
      message: { version: 3 },
    });
    await expect(
      messages.send({ ...input, text: 'Different request' }),
    ).resolves.toEqual({ status: 'idempotency-conflict' });
    await messages.mutate({ ...base, mutation: { kind: 'delete' } });
    await expect(messages.send(input)).resolves.toMatchObject({
      status: 'existing',
      message: { text: null, deletedAt: NOW, reactions: [], version: 4 },
    });
    await expect(
      prisma.messageReaction.count({ where: { messageId: message.id } }),
    ).resolves.toBe(0);
    await expect(
      prisma.conversationMember.findUnique({
        where: { conversationId_userId: { conversationId, userId: MEMBER } },
      }),
    ).resolves.toMatchObject({ unreadCount: 1 });
  });

  it('enforces same-conversation replies, literal search, and clear boundaries in PostgreSQL', async () => {
    const target = await createMessage();
    const reply = await createMessage({
      ...sendInput('Reply'),
      replyToMessageId: target.id,
    });
    expect(reply.replyToMessageId).toBe(target.id);
    await expect(
      messages.listForMember(conversationId, MEMBER, null, 20, '50%_off'),
    ).resolves.toMatchObject({ messages: [{ id: target.id }] });
    await createMessage(sendInput('50XYZoff'));
    await expect(
      messages.listForMember(conversationId, MEMBER, null, 20, '50%_off'),
    ).resolves.toMatchObject({ messages: [{ id: target.id }] });
    const other = await conversations.createGroup({
      creatorId: OWNER,
      name: 'Other',
      participantIds: [MEMBER],
      avatarMediaId: null,
      now: NOW,
    });
    if (other.status !== 'created') throw new Error(other.status);
    await expect(
      messages.send({
        ...sendInput(),
        conversationId: other.conversation.id,
        replyToMessageId: target.id,
      }),
    ).resolves.toEqual({ status: 'reply-unavailable' });
    await expect(
      prisma.message.create({
        data: {
          conversationId: other.conversation.id,
          senderId: OWNER,
          clientMessageId: randomUUID(),
          text: 'Bypass service',
          replyToMessageId: target.id,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await messages.clearForMember(conversationId, MEMBER, NOW);
    await expect(
      messages.getForMember(conversationId, MEMBER, target.id),
    ).resolves.toEqual({ status: 'message-not-found' });
    await expect(
      messages.send({
        ...sendInput('Hidden reply'),
        senderId: MEMBER,
        replyToMessageId: target.id,
      }),
    ).resolves.toEqual({ status: 'reply-unavailable' });
    await expect(
      messages.listForMember(conversationId, MEMBER, null, 20, '50%_off'),
    ).resolves.toMatchObject({ messages: [] });
    await messages.mutate({
      conversationId,
      actorId: OWNER,
      messageId: target.id,
      mutation: { kind: 'delete' },
      now: NOW,
    });
    await expect(
      messages.getForMember(conversationId, OWNER, reply.id),
    ).resolves.toMatchObject({ message: { replyToMessageId: target.id } });
    await expect(
      messages.listForMember(conversationId, OWNER, null, 20, '50%_off'),
    ).resolves.toMatchObject({ messages: [] });
  });

  it.each(['VIDEO', 'DOCUMENT'] as const)(
    'keeps %s media single-use even after message deletion',
    async (kind) => {
      const id = randomUUID();
      const video = kind === 'VIDEO';
      await prisma.mediaAsset.create({
        data: {
          id,
          ownerId: OWNER,
          clientUploadId: randomUUID(),
          purpose: 'MESSAGE_ATTACHMENT',
          status: 'READY',
          uploadFingerprint: 'a'.repeat(64),
          cloudinaryPublicId: `integration/${id}${video ? '' : '.pdf'}`,
          cloudinaryAssetId: randomUUID(),
          resourceType: video ? 'video' : 'raw',
          deliveryType: 'upload',
          mimeType: video ? 'video/mp4' : 'application/pdf',
          format: video ? 'mp4' : 'pdf',
          byteSize: 12000,
          width: video ? 640 : null,
          height: video ? 480 : null,
          durationMs: video ? 15000 : null,
          originalFilename: video ? 'lesson.mp4' : 'lesson.pdf',
          secureUrl: `https://res.cloudinary.com/classroom/${video ? 'video' : 'raw'}/upload/lesson.${video ? 'mp4' : 'pdf'}`,
          completedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 600000),
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      const input = { ...sendInput(), attachmentMediaIds: [id] };
      const sent = await createMessage(input);
      expect(sent.kind).toBe(kind);
      expect(sent.attachments).toHaveLength(1);
      await messages.mutate({
        conversationId,
        actorId: OWNER,
        messageId: sent.id,
        mutation: { kind: 'delete' },
        now: NOW,
      });
      await expect(messages.send(input)).resolves.toMatchObject({
        status: 'existing',
        message: { attachments: [], deletedAt: NOW },
      });
      await expect(
        messages.send({ ...input, clientMessageId: randomUUID() }),
      ).resolves.toEqual({ status: 'attachment-unavailable' });
      await expect(
        prisma.messageAttachment.count({ where: { mediaAssetId: id } }),
      ).resolves.toBe(1);
      await expect(
        prisma.mediaAsset.findUnique({ where: { id } }),
      ).resolves.toMatchObject({ messageClaimedAt: expect.any(Date) });
    },
  );
});

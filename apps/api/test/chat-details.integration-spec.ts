import { randomUUID } from 'node:crypto';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaMessagesRepository } from '../src/messages/prisma-messages.repository';
import { PrismaAuthRepository } from '../src/auth/prisma-auth.repository';
import { ParticipantProfilesService } from '../src/users/participant-profiles.service';
import { MessageStarsService } from '../src/messages/message-stars.service';
import { UsersService } from '../src/users/users.service';

const A = '00000000-0000-4000-8000-000000002801';
const B = '00000000-0000-4000-8000-000000002802';
const C = '00000000-0000-4000-8000-000000002803';
const NOW = new Date('2026-10-28T10:00:00.000Z');

describe('chat details persistence and privacy', () => {
  const prisma = new PrismaService();
  const messages = new PrismaMessagesRepository(prisma);
  const auth = new PrismaAuthRepository(prisma);
  const users = new UsersService(auth);
  const profiles = new ParticipantProfilesService(prisma);
  const stars = new MessageStarsService(prisma);
  let chat: string;

  async function cleanup() {
    await prisma.conversation.deleteMany({ where: { createdById: A } });
    await prisma.mediaAsset.deleteMany({
      where: { ownerId: { in: [A, B, C] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [A, B, C] } } });
  }
  beforeEach(async () => {
    await cleanup();
    await prisma.user.createMany({
      data: [A, B, C].map((id, i) => ({
        id,
        phoneNumber: `+1202555280${i}`,
        phoneVerifiedAt: NOW,
        displayName: `Details ${i}`,
      })),
    });
    chat = (
      await prisma.conversation.create({
        data: {
          type: 'GROUP',
          name: 'Details',
          createdById: A,
          members: { create: [{ userId: A, role: 'OWNER' }, { userId: B }] },
        },
      })
    ).id;
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  async function send(text: string, at = NOW) {
    const result = await messages.send({
      conversationId: chat,
      senderId: A,
      clientMessageId: randomUUID(),
      text,
      attachmentMediaIds: [],
      now: at,
    });
    if (result.status !== 'created') throw new Error(result.status);
    return result.message;
  }

  it('shares bio with members, keeps sensitive fields opt-in, and excludes blocked/nonmembers', async () => {
    await users.updateMe(B, { bio: 'Learning mobile' });
    expect(await users.getMe(B)).toMatchObject({
      bio: 'Learning mobile',
      sharePhoneNumber: false,
      shareLastSeen: false,
      profileComplete: false,
    });
    await auth.recordLastSeen([B], NOW);
    expect(await profiles.get(A, chat, B)).toMatchObject({
      bio: 'Learning mobile',
      phoneNumber: null,
      lastSeenAt: null,
    });
    await users.updateMe(B, { sharePhoneNumber: true, shareLastSeen: true });
    expect(await profiles.get(A, chat, B)).toMatchObject({
      phoneNumber: '+12025552801',
      lastSeenAt: NOW.toISOString(),
    });
    await expect(profiles.get(C, chat, B)).rejects.toMatchObject({
      status: 404,
    });
    await expect(profiles.get(A, chat, C)).rejects.toMatchObject({
      status: 404,
    });
    for (const [blockerId, blockedId] of [
      [A, B],
      [B, A],
    ] as const) {
      await prisma.userBlock.create({ data: { blockerId, blockedId } });
      await expect(profiles.get(A, chat, B)).rejects.toMatchObject({
        status: 404,
      });
      await prisma.userBlock.deleteMany({ where: { blockerId, blockedId } });
    }
    await users.updateMe(B, {
      bio: '',
      sharePhoneNumber: false,
      shareLastSeen: false,
    });
    expect(await profiles.get(A, chat, B)).toMatchObject({
      bio: null,
      phoneNumber: null,
      lastSeenAt: null,
    });
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: chat, userId: B } },
    });
    await expect(profiles.get(A, chat, B)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('persists observations across service instances without moving last-seen backwards', async () => {
    const later = new Date(NOW.getTime() + 30_000);
    await Promise.all([
      auth.recordLastSeen([B], later),
      auth.recordLastSeen([B], NOW),
    ]);
    const reloaded = new UsersService(new PrismaAuthRepository(prisma));
    expect(await reloaded.getMe(B)).toMatchObject({
      lastSeenAt: later.toISOString(),
    });
  });

  it('stores stars privately and idempotently; never reveals cleared, deleted or inaccessible messages', async () => {
    const message = await send('Star this');
    await Promise.all([
      stars.set(B, chat, message.id, true),
      stars.set(B, chat, message.id, true),
    ]);
    expect(await stars.get(B, chat, message.id)).toMatchObject({
      starred: true,
    });
    expect(await stars.get(A, chat, message.id)).toMatchObject({
      starred: false,
    });
    expect(
      await messages.listForMember(chat, B, null, 10, undefined, {
        collection: 'starred',
      }),
    ).toMatchObject({ messages: [{ id: message.id }] });
    expect(
      await messages.listForMember(chat, A, null, 10, undefined, {
        collection: 'starred',
      }),
    ).toMatchObject({ messages: [] });
    await expect(stars.set(C, chat, message.id, true)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      stars.set(B, randomUUID(), message.id, true),
    ).rejects.toMatchObject({ status: 404 });
    await stars.set(B, chat, message.id, false);
    await stars.set(B, chat, message.id, false);
    expect(await stars.get(B, chat, message.id)).toMatchObject({
      starred: false,
    });
    await stars.set(B, chat, message.id, true);
    await messages.clearForMember(chat, B, NOW);
    expect(
      await messages.listForMember(chat, B, null, 10, undefined, {
        collection: 'starred',
      }),
    ).toMatchObject({ messages: [] });
    await expect(stars.get(B, chat, message.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(stars.set(B, chat, message.id, true)).rejects.toMatchObject({
      status: 404,
    });
    await stars.set(A, chat, message.id, true);
    await messages.mutate({
      actorId: A,
      conversationId: chat,
      messageId: message.id,
      mutation: { kind: 'delete' },
      now: NOW,
    });
    expect(
      await messages.listForMember(chat, A, null, 10, undefined, {
        collection: 'starred',
      }),
    ).toMatchObject({ messages: [] });
    await expect(stars.set(A, chat, message.id, true)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('indexes HTTP links on creation and editing, deduplicates and removes them on deletion', async () => {
    const first = await send(
      'Visit https://example.com/lesson and https://example.com/lesson. (http://example.org/a) javascript:alert(1)',
    );
    expect(first.links).toEqual([
      'https://example.com/lesson',
      'http://example.org/a',
    ]);
    const second = await send(
      'https://example.com/new',
      new Date(NOW.getTime() + 1),
    );
    await send('Plain message', new Date(NOW.getTime() + 2));
    expect(
      await messages.listForMember(chat, B, null, 1, undefined, {
        collection: 'links',
      }),
    ).toMatchObject({ messages: [{ id: second.id }] });
    expect(
      await messages.listForMember(
        chat,
        B,
        { id: second.id, createdAt: second.createdAt },
        1,
        undefined,
        { collection: 'links' },
      ),
    ).toMatchObject({ messages: [{ id: first.id }] });
    await messages.mutate({
      actorId: A,
      conversationId: chat,
      messageId: first.id,
      mutation: {
        kind: 'edit',
        text: 'Now https://example.net/edited',
        expectedVersion: 0,
      },
      now: NOW,
    });
    expect(await messages.getForMember(chat, B, first.id)).toMatchObject({
      message: { links: ['https://example.net/edited'] },
    });
    await messages.mutate({
      actorId: A,
      conversationId: chat,
      messageId: first.id,
      mutation: { kind: 'delete' },
      now: NOW,
    });
    expect(await messages.getForMember(chat, B, first.id)).toMatchObject({
      message: { links: [] },
    });
    await messages.clearForMember(chat, B, new Date(NOW.getTime() + 3));
    expect(
      await messages.listForMember(chat, B, null, 10, undefined, {
        collection: 'links',
      }),
    ).toMatchObject({ messages: [] });
    expect(
      await messages.listForMember(chat, C, null, 10, undefined, {
        collection: 'links',
      }),
    ).toEqual({ status: 'conversation-not-found' });
  });

  it('preserves balanced URL punctuation while stripping surrounding prose', async () => {
    const message = await send(
      'https://en.wikipedia.org/wiki/Function_(mathematics) (https://example.org/a) [https://example.org/list[1]]',
    );
    expect(message.links).toEqual([
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
      'https://example.org/a',
      'https://example.org/list[1]',
    ]);
  });

  it('paginates and filters media while respecting deletes, clear boundaries and membership removal', async () => {
    const mediaMessages: string[] = [];
    for (const kind of ['image', 'audio', 'video', 'document'] as const) {
      const id = randomUUID();
      const format = {
        image: 'jpg',
        audio: 'mp3',
        video: 'mp4',
        document: 'pdf',
      }[kind];
      const mimeType = {
        image: 'image/jpeg',
        audio: 'audio/mpeg',
        video: 'video/mp4',
        document: 'application/pdf',
      }[kind];
      const resourceType =
        kind === 'image' ? 'image' : kind === 'document' ? 'raw' : 'video';
      await prisma.mediaAsset.create({
        data: {
          id,
          ownerId: A,
          clientUploadId: randomUUID(),
          uploadFingerprint: 'a'.repeat(64),
          purpose: 'MESSAGE_ATTACHMENT',
          status: 'READY',
          cloudinaryPublicId: `integration/${id}${kind === 'document' ? '.pdf' : ''}`,
          cloudinaryAssetId: randomUUID(),
          resourceType,
          format,
          mimeType,
          byteSize: 1000,
          width: ['image', 'video'].includes(kind) ? 640 : null,
          height: ['image', 'video'].includes(kind) ? 480 : null,
          durationMs: ['audio', 'video'].includes(kind) ? 1000 : null,
          originalFilename: `lesson.${format}`,
          secureUrl: `https://res.cloudinary.com/demo/${resourceType}/upload/${id}.${format}`,
          completedAt: NOW,
          expiresAt: new Date(NOW.getTime() + 600000),
          createdAt: NOW,
          updatedAt: NOW,
        },
      });
      const result = await messages.send({
        conversationId: chat,
        senderId: A,
        clientMessageId: randomUUID(),
        text: null,
        attachmentMediaIds: [id],
        now: NOW,
      });
      if (result.status !== 'created') throw new Error(result.status);
      mediaMessages.push(result.message.id);
      expect(
        await messages.listForMember(chat, B, null, 10, undefined, {
          collection: 'media',
          kind,
        }),
      ).toMatchObject({
        messages: [{ id: result.message.id, attachments: [{ type: kind }] }],
      });
    }
    await send('No media');
    const expected = [...mediaMessages].sort().reverse();
    const first = await messages.listForMember(chat, B, null, 2, undefined, {
      collection: 'media',
    });
    if (first.status !== 'found') throw new Error(first.status);
    expect(first.messages.map((m) => m.id)).toEqual(expected.slice(0, 2));
    const last = first.messages.at(-1)!;
    const second = await messages.listForMember(
      chat,
      B,
      { id: last.id, createdAt: last.createdAt },
      2,
      undefined,
      { collection: 'media' },
    );
    if (second.status !== 'found') throw new Error(second.status);
    expect(second.messages.map((m) => m.id)).toEqual(expected.slice(2));
    await messages.mutate({
      actorId: A,
      conversationId: chat,
      messageId: last.id,
      mutation: { kind: 'delete' },
      now: NOW,
    });
    const remaining = await messages.listForMember(
      chat,
      B,
      null,
      10,
      undefined,
      { collection: 'media' },
    );
    if (remaining.status !== 'found') throw new Error(remaining.status);
    expect(remaining.messages).toHaveLength(3);
    await messages.clearForMember(chat, B, NOW);
    expect(
      await messages.listForMember(chat, B, null, 10, undefined, {
        collection: 'media',
      }),
    ).toMatchObject({ messages: [] });
    await prisma.conversationMember.delete({
      where: { conversationId_userId: { conversationId: chat, userId: B } },
    });
    expect(
      await messages.listForMember(chat, B, null, 10, undefined, {
        collection: 'media',
      }),
    ).toEqual({ status: 'conversation-not-found' });
  });
});

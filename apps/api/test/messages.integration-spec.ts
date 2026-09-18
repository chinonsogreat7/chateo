import { MediaPurpose, MediaStatus } from '@prisma/client';
import { Clock } from '../src/auth/providers/clock';
import { NoopConversationEventsPublisher } from '../src/conversations/conversation-events.publisher';
import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
import { ConversationsService } from '../src/conversations/conversations.service';
import { PrismaService } from '../src/database/prisma.service';
import { NoopMessageEventsPublisher } from '../src/messages/message-events.publisher';
import { PrismaMessagesRepository } from '../src/messages/prisma-messages.repository';
import { MessagesService } from '../src/messages/messages.service';
import type { MessageRecord } from '../src/messages/messages.types';

const SENDER_ID = '00000000-0000-4000-8000-000000000501';
const RECIPIENT_ID = '00000000-0000-4000-8000-000000000502';
const OUTSIDER_ID = '00000000-0000-4000-8000-000000000503';
const USER_IDS = [SENDER_ID, RECIPIENT_ID, OUTSIDER_ID];

const CLIENT_MESSAGE_ONE = '10000000-0000-4000-8000-000000000501';
const CLIENT_MESSAGE_TWO = '10000000-0000-4000-8000-000000000502';
const CLIENT_MESSAGE_THREE = '10000000-0000-4000-8000-000000000503';
const CLIENT_MESSAGE_FOUR = '10000000-0000-4000-8000-000000000504';

const MEDIA_ONE = '20000000-0000-4000-8000-000000000501';
const MEDIA_TWO = '20000000-0000-4000-8000-000000000502';
const MEDIA_FOREIGN = '20000000-0000-4000-8000-000000000503';
const MEDIA_PENDING = '20000000-0000-4000-8000-000000000504';
const MEDIA_REUSED = '20000000-0000-4000-8000-000000000505';
const MEDIA_RACE = '20000000-0000-4000-8000-000000000506';
const MEDIA_AUDIO = '20000000-0000-4000-8000-000000000507';

const BASE_TIME = new Date('2026-08-12T16:30:00.000Z');
const MESSAGE_TIME_ONE = new Date('2026-08-12T16:31:00.000Z');
const MESSAGE_TIME_TWO = new Date('2026-08-12T16:32:00.000Z');
const MESSAGE_TIME_THREE = new Date('2026-08-12T16:33:00.000Z');
const MESSAGE_TIME_FOUR = new Date('2026-08-12T16:34:00.000Z');

class FixedClock extends Clock {
  now(): Date {
    return BASE_TIME;
  }
}

describe('Prisma messaging persistence', () => {
  const prisma = new PrismaService();
  const messagesRepository = new PrismaMessagesRepository(prisma);
  const conversationsRepository = new PrismaConversationsRepository(prisma);
  const messagesService = new MessagesService(
    messagesRepository,
    new FixedClock(),
    new NoopMessageEventsPublisher(),
  );
  const conversationsService = new ConversationsService(
    conversationsRepository,
    new FixedClock(),
    new NoopConversationEventsPublisher(),
  );
  let conversationId: string;

  beforeAll(async () => {
    await cleanup();
    await prisma.user.createMany({
      data: [
        {
          id: SENDER_ID,
          phoneNumber: '+12025550201',
          phoneVerifiedAt: BASE_TIME,
          displayName: 'Messaging Sender',
          profileCompletedAt: BASE_TIME,
        },
        {
          id: RECIPIENT_ID,
          phoneNumber: '+12025550202',
          phoneVerifiedAt: BASE_TIME,
          displayName: 'Messaging Recipient',
          profileCompletedAt: BASE_TIME,
        },
        {
          id: OUTSIDER_ID,
          phoneNumber: '+12025550203',
          phoneVerifiedAt: BASE_TIME,
          displayName: 'Messaging Outsider',
          profileCompletedAt: BASE_TIME,
        },
      ],
    });

    const result = await conversationsRepository.createOrGetDirect(
      SENDER_ID,
      RECIPIENT_ID,
      BASE_TIME,
    );
    if (result.status === 'participant-not-found') {
      throw new Error('Seeded messaging integration users were not found.');
    }
    conversationId = result.conversation.id;
  });

  beforeEach(async () => {
    await prisma.message.deleteMany({ where: { conversationId } });
    await prisma.mediaAsset.deleteMany({
      where: { ownerId: { in: USER_IDS } },
    });
    await prisma.conversationMember.updateMany({
      where: { conversationId },
      data: {
        unreadCount: 0,
        lastReadAt: null,
        archivedAt: null,
        deletedAt: null,
        pinnedAt: null,
        favoritedAt: null,
        mutedAt: null,
        mutedUntil: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });
    await prisma.conversation.update({
      where: { id: conversationId },
      data: { lastActivityAt: BASE_TIME, updatedAt: BASE_TIME },
    });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it.each([SENDER_ID, RECIPIENT_ID])(
    'restores a deleted direct chat only for a new message from %s, keeping old history cleared',
    async (newSender) => {
      const old = await sendMessage(
        SENDER_ID,
        CLIENT_MESSAGE_ONE,
        'Old history',
        MESSAGE_TIME_ONE,
      );
      await prisma.conversationMember.update({
        where: {
          conversationId_userId: { conversationId, userId: RECIPIENT_ID },
        },
        data: {
          archivedAt: BASE_TIME,
          pinnedAt: BASE_TIME,
          favoritedAt: BASE_TIME,
          mutedAt: BASE_TIME,
        },
      });
      const peerBefore = await prisma.conversationMember.findUniqueOrThrow({
        where: { conversationId_userId: { conversationId, userId: SENDER_ID } },
      });
      const deletion = await conversationsService.deleteForMe(
        RECIPIENT_ID,
        conversationId,
      );
      expect(deletion).toMatchObject({
        changed: true,
        clearedAt: old.createdAt.toISOString(),
        clearedThroughMessageId: old.id,
      });
      expect(
        await conversationsService.deleteForMe(RECIPIENT_ID, conversationId),
      ).toEqual({ ...deletion, changed: false });
      for (const archived of [false, true]) {
        expect(
          await conversationsRepository.listForUser(
            RECIPIENT_ID,
            null,
            10,
            archived,
          ),
        ).toEqual([]);
        expect(
          await conversationsRepository.listForUser(
            RECIPIENT_ID,
            null,
            10,
            archived,
            true,
          ),
        ).toEqual([]);
      }
      expect(
        await conversationsRepository.listForUser(SENDER_ID, null, 10),
      ).toHaveLength(1);
      expect(
        await prisma.conversationMember.findUniqueOrThrow({
          where: {
            conversationId_userId: { conversationId, userId: SENDER_ID },
          },
        }),
      ).toEqual(peerBefore);
      expect(
        await conversationsService.get(RECIPIENT_ID, conversationId),
      ).toMatchObject({
        latestMessage: null,
        unreadCount: 0,
        settings: {
          deletedAt: deletion.deletedAt,
          archived: false,
          pinned: false,
          favorited: false,
          muted: true,
        },
      });
      expect(
        await messagesRepository.listForMember(
          conversationId,
          RECIPIENT_ID,
          null,
          10,
        ),
      ).toMatchObject({ messages: [] });
      expect(
        await messagesRepository.getForMember(
          conversationId,
          RECIPIENT_ID,
          old.id,
        ),
      ).toEqual({ status: 'message-not-found' });
      expect(
        await messagesRepository.listForMember(
          conversationId,
          RECIPIENT_ID,
          null,
          10,
          'Old',
        ),
      ).toMatchObject({ messages: [] });

      await conversationsRepository.createOrGetDirect(
        RECIPIENT_ID,
        SENDER_ID,
        MESSAGE_TIME_TWO,
      );
      await messagesRepository.sendText({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Old history',
        now: MESSAGE_TIME_TWO,
      });
      expect(
        await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
      ).toEqual([]);
      // A lower client clock still produces a message beyond the old clear boundary.
      const next = await sendMessage(
        newSender,
        CLIENT_MESSAGE_TWO,
        'New message',
        BASE_TIME,
      );
      expect(next.createdAt > old.createdAt).toBe(true);
      expect(
        await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
      ).toHaveLength(1);
      expect(
        await conversationsService.get(RECIPIENT_ID, conversationId),
      ).toMatchObject({
        settings: {
          deletedAt: null,
          clearedThroughMessageId: old.id,
          muted: true,
        },
        unreadCount: newSender === RECIPIENT_ID ? 0 : 1,
        latestMessage: { id: next.id },
      });
      expect(
        await messagesRepository.listForMember(
          conversationId,
          RECIPIENT_ID,
          null,
          10,
        ),
      ).toMatchObject({ messages: [{ id: next.id }] });
      const peerHistory = await messagesRepository.listForMember(
        conversationId,
        SENDER_ID,
        null,
        10,
      );
      expect(
        peerHistory.status === 'found' && peerHistory.messages.length,
      ).toBe(2);
      expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
    },
  );

  it('keeps deletion private and rejects group deletion through the for-me route', async () => {
    await expect(
      conversationsService.deleteForMe(OUTSIDER_ID, conversationId),
    ).rejects.toMatchObject({ response: { code: 'CONVERSATION_NOT_FOUND' } });
    const group = await conversationsService.createGroup(SENDER_ID, {
      name: 'Not a direct chat',
      participantIds: [RECIPIENT_ID],
    });
    await expect(
      conversationsService.deleteForMe(SENDER_ID, group.id),
    ).rejects.toMatchObject({
      response: { code: 'CONVERSATION_DIRECT_REQUIRED' },
    });
    await expect(
      conversationsService.deleteForMe(OUTSIDER_ID, group.id),
    ).rejects.toMatchObject({ response: { code: 'CONVERSATION_NOT_FOUND' } });
    await conversationsService.deleteGroup(SENDER_ID, group.id);
  });

  it('handles empty chats, independent deletion by both users, and first-message restoration', async () => {
    const deleted = await conversationsService.deleteForMe(
      SENDER_ID,
      conversationId,
    );
    expect(deleted).toMatchObject({
      changed: true,
      clearedAt: null,
      clearedThroughMessageId: null,
    });
    await conversationsService.deleteForMe(RECIPIENT_ID, conversationId);
    const newMessage = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'First',
      BASE_TIME,
    );
    for (const userId of [SENDER_ID, RECIPIENT_ID]) {
      expect(await conversationsService.list(userId, 10)).toMatchObject({
        items: [
          {
            id: conversationId,
            settings: { deletedAt: null },
            latestMessage: { id: newMessage.id },
          },
        ],
      });
    }
  });

  it('allows local deletion after blocking, but a blocked send cannot restore it', async () => {
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Before block',
      MESSAGE_TIME_ONE,
    );
    await prisma.userBlock.create({
      data: { blockerId: RECIPIENT_ID, blockedId: SENDER_ID },
    });
    try {
      await conversationsService.deleteForMe(RECIPIENT_ID, conversationId);
      expect(
        await messagesRepository.sendText({
          conversationId,
          senderId: SENDER_ID,
          clientMessageId: CLIENT_MESSAGE_TWO,
          text: 'Blocked',
          now: MESSAGE_TIME_TWO,
        }),
      ).toEqual({ status: 'conversation-not-found' });
      expect(
        await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
      ).toEqual([]);
    } finally {
      await prisma.userBlock.delete({
        where: {
          blockerId_blockedId: {
            blockerId: RECIPIENT_ID,
            blockedId: SENDER_ID,
          },
        },
      });
    }
  });

  it.each([SENDER_ID, RECIPIENT_ID])(
    'serializes concurrent deletion and send from %s without an inconsistent boundary',
    async (newSender) => {
      const old = await sendMessage(
        SENDER_ID,
        CLIENT_MESSAGE_ONE,
        'Before race',
        MESSAGE_TIME_ONE,
      );
      const [, next] = await Promise.all([
        conversationsRepository.deleteDirectForMember(
          conversationId,
          RECIPIENT_ID,
          MESSAGE_TIME_TWO,
        ),
        sendMessage(
          newSender,
          CLIENT_MESSAGE_TWO,
          'Concurrent new message',
          MESSAGE_TIME_TWO,
        ),
      ]);
      const state = await conversationsService.get(
        RECIPIENT_ID,
        conversationId,
      );
      const history = await messagesRepository.listForMember(
        conversationId,
        RECIPIENT_ID,
        null,
        10,
      );
      if (state.settings.deletedAt) {
        expect(state.settings.clearedThroughMessageId).toBe(next.id);
        expect(state.unreadCount).toBe(0);
        expect(history).toMatchObject({ messages: [] });
        expect(
          await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
        ).toEqual([]);
      } else {
        expect(state.settings.clearedThroughMessageId).toBe(old.id);
        expect(state.unreadCount).toBe(newSender === RECIPIENT_ID ? 0 : 1);
        expect(history).toMatchObject({ messages: [{ id: next.id }] });
        expect(
          await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
        ).toHaveLength(1);
      }
      expect(await prisma.message.count({ where: { conversationId } })).toBe(2);
    },
  );

  it('keeps both independent history boundaries when both users delete a populated chat', async () => {
    const old = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Old for both',
      MESSAGE_TIME_ONE,
    );
    await Promise.all([
      conversationsService.deleteForMe(SENDER_ID, conversationId),
      conversationsService.deleteForMe(RECIPIENT_ID, conversationId),
    ]);
    for (const userId of [SENDER_ID, RECIPIENT_ID]) {
      expect(
        await conversationsRepository.listForUser(userId, null, 10),
      ).toEqual([]);
    }
    const next = await sendMessage(
      RECIPIENT_ID,
      CLIENT_MESSAGE_TWO,
      'Fresh for both',
      MESSAGE_TIME_TWO,
    );
    for (const userId of [SENDER_ID, RECIPIENT_ID]) {
      expect(
        await messagesRepository.listForMember(
          conversationId,
          userId,
          null,
          10,
        ),
      ).toMatchObject({ messages: [{ id: next.id }] });
      expect(
        await conversationsService.get(userId, conversationId),
      ).toMatchObject({
        settings: { deletedAt: null, clearedThroughMessageId: old.id },
      });
    }
  });

  it('does not restore on a rejected attachment, but restores when verified media is sent', async () => {
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Before photo',
      MESSAGE_TIME_ONE,
    );
    await conversationsService.deleteForMe(RECIPIENT_ID, conversationId);
    const input = {
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_TWO,
      text: null,
      attachmentMediaIds: [MEDIA_ONE],
      now: MESSAGE_TIME_TWO,
    };
    expect(await messagesRepository.send(input)).toEqual({
      status: 'attachment-unavailable',
    });
    expect(
      await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
    ).toEqual([]);
    await seedMessageImage(MEDIA_ONE);
    const result = await messagesRepository.send(input);
    expect(result.status).toBe('created');
    expect(
      await conversationsService.get(RECIPIENT_ID, conversationId),
    ).toMatchObject({
      settings: { deletedAt: null },
      latestMessage: { kind: 'image' },
    });
    expect(
      await conversationsRepository.listForUser(RECIPIENT_ID, null, 10),
    ).toHaveLength(1);
  });

  it('converges concurrent identical sends to one row and one unread increment', async () => {
    const input = {
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: 'Exactly once',
      now: MESSAGE_TIME_ONE,
    };

    const results = await Promise.all([
      messagesRepository.sendText(input),
      messagesRepository.sendText(input),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      'created',
      'existing',
    ]);
    await expect(
      prisma.message.count({
        where: {
          conversationId,
          senderId: SENDER_ID,
          clientMessageId: CLIENT_MESSAGE_ONE,
        },
      }),
    ).resolves.toBe(1);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
    await expect(memberUnreadCount(SENDER_ID)).resolves.toBe(0);
  });

  it('converges concurrent identical image sends after one permanent media claim', async () => {
    await seedMessageImage(MEDIA_RACE);
    const input = {
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: 'Exactly one photo',
      attachmentMediaIds: [MEDIA_RACE],
      now: MESSAGE_TIME_ONE,
    };

    const results = await Promise.all([
      messagesRepository.send(input),
      messagesRepository.send(input),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      'created',
      'existing',
    ]);
    await expect(
      prisma.message.count({
        where: {
          conversationId,
          senderId: SENDER_ID,
          clientMessageId: CLIENT_MESSAGE_ONE,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.messageAttachment.count({
        where: { mediaAssetId: MEDIA_RACE },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: MEDIA_RACE },
        select: { messageClaimedAt: true },
      }),
    ).resolves.toEqual({ messageClaimedAt: MESSAGE_TIME_ONE });
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('persists ordered image attachments and maps them into message history', async () => {
    await seedMessageImage(MEDIA_ONE, {
      mimeType: 'image/png',
      byteSize: 101_001,
      width: 640,
      height: 480,
    });
    await seedMessageImage(MEDIA_TWO, {
      mimeType: 'image/webp',
      byteSize: 202_002,
      width: 1280,
      height: 720,
    });

    const result = await messagesRepository.send({
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: 'Two photos',
      attachmentMediaIds: [MEDIA_TWO, MEDIA_ONE],
      now: MESSAGE_TIME_ONE,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') {
      throw new Error(`Expected a created message, received ${result.status}.`);
    }
    expect(result.message).toMatchObject({
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      kind: 'IMAGE',
      text: 'Two photos',
      attachments: [
        {
          mediaId: MEDIA_TWO,
          type: 'image',
          contentType: 'image/webp',
          sizeBytes: 202_002,
          width: 1280,
          height: 720,
          url: mediaUrl(MEDIA_TWO, 'webp'),
        },
        {
          mediaId: MEDIA_ONE,
          type: 'image',
          contentType: 'image/png',
          sizeBytes: 101_001,
          width: 640,
          height: 480,
          url: mediaUrl(MEDIA_ONE, 'png'),
        },
      ],
    });

    await expect(
      prisma.messageAttachment.findMany({
        where: { messageId: result.message.id },
        orderBy: { position: 'asc' },
        select: { mediaAssetId: true, position: true },
      }),
    ).resolves.toEqual([
      { mediaAssetId: MEDIA_TWO, position: 0 },
      { mediaAssetId: MEDIA_ONE, position: 1 },
    ]);

    await expect(
      messagesService.list(SENDER_ID, conversationId, 20),
    ).resolves.toMatchObject({
      items: [
        {
          id: result.message.id,
          conversationId,
          senderId: SENDER_ID,
          clientMessageId: CLIENT_MESSAGE_ONE,
          kind: 'image',
          text: 'Two photos',
          attachments: [
            {
              mediaId: MEDIA_TWO,
              type: 'image',
              contentType: 'image/webp',
              sizeBytes: 202_002,
              width: 1280,
              height: 720,
              url: mediaUrl(MEDIA_TWO, 'webp'),
            },
            {
              mediaId: MEDIA_ONE,
              type: 'image',
              contentType: 'image/png',
              sizeBytes: 101_001,
              width: 640,
              height: 480,
              url: mediaUrl(MEDIA_ONE, 'png'),
            },
          ],
          createdAt: MESSAGE_TIME_ONE.toISOString(),
        },
      ],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });
  });

  it('returns the existing image message when its identical retry follows the attachment claim', async () => {
    await seedMessageImage(MEDIA_ONE);
    const input = {
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: null,
      attachmentMediaIds: [MEDIA_ONE],
      now: MESSAGE_TIME_ONE,
    };

    const first = await messagesRepository.send(input);
    const replay = await messagesRepository.send({
      ...input,
      now: MESSAGE_TIME_TWO,
    });

    expect(first.status).toBe('created');
    expect(replay.status).toBe('existing');
    if (first.status !== 'created' || replay.status !== 'existing') {
      throw new Error(
        'Expected a created image message and its existing replay.',
      );
    }
    expect(replay.message).toEqual(first.message);
    await expect(
      prisma.messageAttachment.count({
        where: { mediaAssetId: MEDIA_ONE },
      }),
    ).resolves.toBe(1);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('persists one audio recording and maps it into history and the conversation preview', async () => {
    await seedMessageAudio(MEDIA_AUDIO, {
      byteSize: 482_310,
      durationMs: 18_400,
    });

    const result = await messagesRepository.send({
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: null,
      attachmentMediaIds: [MEDIA_AUDIO],
      now: MESSAGE_TIME_ONE,
    });

    expect(result.status).toBe('created');
    if (result.status !== 'created') {
      throw new Error(`Expected a created message, received ${result.status}.`);
    }
    expect(result.message).toMatchObject({
      kind: 'AUDIO',
      text: null,
      attachments: [
        {
          mediaId: MEDIA_AUDIO,
          type: 'audio',
          contentType: 'audio/mp4',
          sizeBytes: 482_310,
          durationMs: 18_400,
          url: audioUrl(MEDIA_AUDIO),
        },
      ],
    });
    await expect(
      messagesService.list(RECIPIENT_ID, conversationId, 20),
    ).resolves.toMatchObject({
      items: [
        {
          id: result.message.id,
          kind: 'audio',
          text: null,
          attachments: [
            {
              mediaId: MEDIA_AUDIO,
              type: 'audio',
              contentType: 'audio/mp4',
              sizeBytes: 482_310,
              durationMs: 18_400,
              url: audioUrl(MEDIA_AUDIO),
            },
          ],
        },
      ],
    });
    await expect(
      conversationsService.get(RECIPIENT_ID, conversationId),
    ).resolves.toMatchObject({
      latestMessage: {
        id: result.message.id,
        kind: 'audio',
        preview: 'Voice message',
      },
    });
  });

  it('replays an identical audio message after its permanent media claim', async () => {
    await seedMessageAudio(MEDIA_AUDIO);
    const input = {
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: 'Listen to this',
      attachmentMediaIds: [MEDIA_AUDIO],
      now: MESSAGE_TIME_ONE,
    };

    const first = await messagesRepository.send(input);
    const replay = await messagesRepository.send({
      ...input,
      now: MESSAGE_TIME_TWO,
    });

    expect(first.status).toBe('created');
    expect(replay.status).toBe('existing');
    if (first.status !== 'created' || replay.status !== 'existing') {
      throw new Error(
        'Expected a created audio message and its existing replay.',
      );
    }
    expect(replay.message).toEqual(first.message);
    await expect(
      prisma.messageAttachment.count({
        where: { mediaAssetId: MEDIA_AUDIO },
      }),
    ).resolves.toBe(1);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('rejects mixed image and audio attachments without claiming either asset', async () => {
    await seedMessageImage(MEDIA_ONE);
    await seedMessageAudio(MEDIA_AUDIO);

    await expect(
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Mixed media',
        attachmentMediaIds: [MEDIA_ONE, MEDIA_AUDIO],
        now: MESSAGE_TIME_ONE,
      }),
    ).resolves.toEqual({ status: 'attachment-unavailable' });
    await expect(
      prisma.mediaAsset.findMany({
        where: { id: { in: [MEDIA_ONE, MEDIA_AUDIO] } },
        orderBy: { id: 'asc' },
        select: { messageClaimedAt: true },
      }),
    ).resolves.toEqual([
      { messageClaimedAt: null },
      { messageClaimedAt: null },
    ]);
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(0);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(0);
  });

  it('rejects an image idempotency replay when attachment order changes', async () => {
    await seedMessageImage(MEDIA_ONE);
    await seedMessageImage(MEDIA_TWO);
    await expect(
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Ordered photos',
        attachmentMediaIds: [MEDIA_ONE, MEDIA_TWO],
        now: MESSAGE_TIME_ONE,
      }),
    ).resolves.toMatchObject({ status: 'created' });

    await expect(
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Ordered photos',
        attachmentMediaIds: [MEDIA_TWO, MEDIA_ONE],
        now: MESSAGE_TIME_TWO,
      }),
    ).resolves.toEqual({ status: 'idempotency-conflict' });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(1);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('hides whether an unavailable image is foreign, pending, or permanently claimed', async () => {
    await seedMessageImage(MEDIA_FOREIGN, { ownerId: OUTSIDER_ID });
    await seedMessageImage(MEDIA_PENDING, {
      status: MediaStatus.PENDING,
    });
    await seedMessageImage(MEDIA_REUSED);
    const original = await messagesRepository.send({
      conversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: null,
      attachmentMediaIds: [MEDIA_REUSED],
      now: MESSAGE_TIME_ONE,
    });
    expect(original.status).toBe('created');
    if (original.status !== 'created') {
      throw new Error(
        `Expected a created message, received ${original.status}.`,
      );
    }
    await prisma.message.delete({ where: { id: original.message.id } });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: MEDIA_REUSED },
        select: { messageClaimedAt: true },
      }),
    ).resolves.toEqual({ messageClaimedAt: expect.any(Date) });
    await expect(
      prisma.messageAttachment.count({
        where: { mediaAssetId: MEDIA_REUSED },
      }),
    ).resolves.toBe(0);

    const unavailableInputs = [
      {
        clientMessageId: CLIENT_MESSAGE_TWO,
        attachmentMediaIds: [MEDIA_FOREIGN],
      },
      {
        clientMessageId: CLIENT_MESSAGE_THREE,
        attachmentMediaIds: [MEDIA_PENDING],
      },
      {
        clientMessageId: CLIENT_MESSAGE_FOUR,
        attachmentMediaIds: [MEDIA_REUSED],
      },
    ];
    for (const unavailable of unavailableInputs) {
      await expect(
        messagesRepository.send({
          conversationId,
          senderId: SENDER_ID,
          text: null,
          now: MESSAGE_TIME_TWO,
          ...unavailable,
        }),
      ).resolves.toEqual({ status: 'attachment-unavailable' });
    }

    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(0);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('rolls back a partial attachment claim when any requested image is unavailable', async () => {
    await seedMessageImage(MEDIA_ONE);
    await seedMessageImage(MEDIA_FOREIGN, { ownerId: OUTSIDER_ID });

    await expect(
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Cannot claim this set',
        attachmentMediaIds: [MEDIA_ONE, MEDIA_FOREIGN],
        now: MESSAGE_TIME_ONE,
      }),
    ).resolves.toEqual({ status: 'attachment-unavailable' });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: MEDIA_ONE },
        select: { messageClaimedAt: true },
      }),
    ).resolves.toEqual({ messageClaimedAt: null });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(0);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(0);

    await expect(
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_TWO,
        text: 'The valid image remains usable',
        attachmentMediaIds: [MEDIA_ONE],
        now: MESSAGE_TIME_TWO,
      }),
    ).resolves.toMatchObject({ status: 'created' });
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: MEDIA_ONE },
        select: { messageClaimedAt: true },
      }),
    ).resolves.toEqual({ messageClaimedAt: expect.any(Date) });
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('converges two different messages racing for one image to one created and one unavailable', async () => {
    await seedMessageImage(MEDIA_RACE);

    const results = await Promise.all([
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Race one',
        attachmentMediaIds: [MEDIA_RACE],
        now: MESSAGE_TIME_ONE,
      }),
      messagesRepository.send({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_TWO,
        text: 'Race two',
        attachmentMediaIds: [MEDIA_RACE],
        now: MESSAGE_TIME_ONE,
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      'attachment-unavailable',
      'created',
    ]);
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.messageAttachment.count({
        where: { mediaAssetId: MEDIA_RACE },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.mediaAsset.findUniqueOrThrow({
        where: { id: MEDIA_RACE },
        select: { messageClaimedAt: true },
      }),
    ).resolves.toEqual({ messageClaimedAt: expect.any(Date) });
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('rejects the same idempotency key with different text without another increment', async () => {
    await expect(
      sendMessage(
        SENDER_ID,
        CLIENT_MESSAGE_ONE,
        'Original payload',
        MESSAGE_TIME_ONE,
      ),
    ).resolves.toMatchObject({ text: 'Original payload' });

    await expect(
      messagesRepository.sendText({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Changed payload',
        now: MESSAGE_TIME_TWO,
      }),
    ).resolves.toEqual({ status: 'idempotency-conflict' });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(1);
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('returns the same not-found result when an outsider sends, reads history, or marks read', async () => {
    await expect(
      messagesRepository.sendText({
        conversationId,
        senderId: OUTSIDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Unauthorized',
        now: MESSAGE_TIME_ONE,
      }),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    await expect(
      messagesRepository.listForMember(conversationId, OUTSIDER_ID, null, 20),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    await expect(
      messagesRepository.markRead(
        conversationId,
        OUTSIDER_ID,
        MESSAGE_TIME_ONE,
      ),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    await expect(
      messagesRepository.clearForMember(
        conversationId,
        OUTSIDER_ID,
        MESSAGE_TIME_ONE,
      ),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(0);
  });

  it('rejects a raw message whose sender is not a conversation member', async () => {
    await expect(
      prisma.message.create({
        data: {
          conversationId,
          senderId: OUTSIDER_ID,
          clientMessageId: CLIENT_MESSAGE_ONE,
          text: 'Raw outsider write',
          createdAt: MESSAGE_TIME_ONE,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(0);
  });

  it('returns stable newest-first history across cursor pages', async () => {
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Message one',
      MESSAGE_TIME_ONE,
    );
    await sendMessage(
      RECIPIENT_ID,
      CLIENT_MESSAGE_TWO,
      'Message two',
      MESSAGE_TIME_TWO,
    );
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_THREE,
      'Message three',
      MESSAGE_TIME_THREE,
    );
    await sendMessage(
      RECIPIENT_ID,
      CLIENT_MESSAGE_FOUR,
      'Message four',
      MESSAGE_TIME_FOUR,
    );

    const firstPage = await messagesService.list(SENDER_ID, conversationId, 2);
    expect(firstPage.items.map((message) => message.text)).toEqual([
      'Message four',
      'Message three',
    ]);
    expect(firstPage.pageInfo).toEqual({
      nextCursor: expect.any(String),
      hasNextPage: true,
    });

    const secondPage = await messagesService.list(
      SENDER_ID,
      conversationId,
      2,
      firstPage.pageInfo.nextCursor ?? undefined,
    );
    expect(secondPage.items.map((message) => message.text)).toEqual([
      'Message two',
      'Message one',
    ]);
    expect(secondPage.pageInfo).toEqual({
      nextCursor: null,
      hasNextPage: false,
    });
    expect(
      new Set([...firstPage.items, ...secondPage.items].map(({ id }) => id))
        .size,
    ).toBe(4);
  });

  it('uses the message UUID as the cursor tie-breaker at equal timestamps', async () => {
    const first = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Equal-time one',
      MESSAGE_TIME_ONE,
    );
    const second = await sendMessage(
      RECIPIENT_ID,
      CLIENT_MESSAGE_TWO,
      'Equal-time two',
      MESSAGE_TIME_ONE,
    );
    const expectedIds = [first.id, second.id].sort().reverse();

    const firstPage = await messagesService.list(SENDER_ID, conversationId, 1);
    const secondPage = await messagesService.list(
      SENDER_ID,
      conversationId,
      1,
      firstPage.pageInfo.nextCursor ?? undefined,
    );

    expect(firstPage.items.map(({ id }) => id)).toEqual(
      expectedIds.slice(0, 1),
    );
    expect(secondPage.items.map(({ id }) => id)).toEqual(expectedIds.slice(1));
  });

  it('clears history at a per-member tuple boundary and reveals the next message', async () => {
    const first = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Clear boundary one',
      MESSAGE_TIME_TWO,
    );
    const second = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_TWO,
      'Clear boundary two',
      MESSAGE_TIME_TWO,
    );
    const boundary = [first, second].sort((left, right) =>
      right.id.localeCompare(left.id),
    )[0];
    if (!boundary) throw new Error('Expected a clear boundary message.');
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(2);

    await expect(
      messagesRepository.clearForMember(
        conversationId,
        RECIPIENT_ID,
        MESSAGE_TIME_THREE,
      ),
    ).resolves.toEqual({
      status: 'cleared',
      conversationId,
      userId: RECIPIENT_ID,
      changed: true,
      clearedAt: MESSAGE_TIME_TWO,
      clearedThroughMessageId: boundary.id,
      occurredAt: MESSAGE_TIME_THREE,
    });
    await expect(
      prisma.conversationMember.findUniqueOrThrow({
        where: {
          conversationId_userId: {
            conversationId,
            userId: RECIPIENT_ID,
          },
        },
        select: {
          clearedAt: true,
          clearedThroughMessageId: true,
          unreadCount: true,
        },
      }),
    ).resolves.toEqual({
      clearedAt: MESSAGE_TIME_TWO,
      clearedThroughMessageId: boundary.id,
      unreadCount: 0,
    });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(2);
    await expect(
      messagesRepository.listForMember(conversationId, RECIPIENT_ID, null, 20),
    ).resolves.toMatchObject({ status: 'found', messages: [] });
    await expect(
      messagesRepository.listForMember(conversationId, SENDER_ID, null, 20),
    ).resolves.toMatchObject({
      status: 'found',
      messages: expect.arrayContaining([
        expect.objectContaining({ id: first.id }),
        expect.objectContaining({ id: second.id }),
      ]),
    });

    const clearedConversation = await conversationsService.get(
      RECIPIENT_ID,
      conversationId,
    );
    expect(clearedConversation.latestMessage).toBeNull();
    expect(clearedConversation.settings).toMatchObject({
      clearedAt: MESSAGE_TIME_TWO.toISOString(),
      clearedThroughMessageId: boundary.id,
    });
    await expect(
      conversationsService.get(SENDER_ID, conversationId),
    ).resolves.toMatchObject({ latestMessage: { id: boundary.id } });

    await expect(
      messagesRepository.clearForMember(
        conversationId,
        RECIPIENT_ID,
        MESSAGE_TIME_FOUR,
      ),
    ).resolves.toMatchObject({ status: 'cleared', changed: false });

    const next = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_THREE,
      'Visible after clear',
      MESSAGE_TIME_ONE,
    );
    expect(next.createdAt).toEqual(new Date(MESSAGE_TIME_TWO.getTime() + 1));
    await expect(
      messagesRepository.listForMember(conversationId, RECIPIENT_ID, null, 20),
    ).resolves.toMatchObject({
      status: 'found',
      messages: [expect.objectContaining({ id: next.id })],
    });
    const senderHistory = await messagesRepository.listForMember(
      conversationId,
      SENDER_ID,
      null,
      20,
    );
    expect(senderHistory.status).toBe('found');
    if (senderHistory.status !== 'found') {
      throw new Error('Expected sender history to remain accessible.');
    }
    expect(senderHistory.messages).toHaveLength(3);
    await expect(
      conversationsService.get(RECIPIENT_ID, conversationId),
    ).resolves.toMatchObject({ latestMessage: { id: next.id } });
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('keeps conversation activity monotonic when an older timestamp is persisted later', async () => {
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Newer timestamp first',
      MESSAGE_TIME_FOUR,
    );
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_TWO,
      'Delayed older timestamp',
      MESSAGE_TIME_ONE,
    );

    await expect(
      prisma.conversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { lastActivityAt: true },
      }),
    ).resolves.toEqual({ lastActivityAt: MESSAGE_TIME_FOUR });
  });

  it('serializes a concurrent send and read without losing the resulting state', async () => {
    await Promise.all([
      messagesRepository.sendText({
        conversationId,
        senderId: SENDER_ID,
        clientMessageId: CLIENT_MESSAGE_ONE,
        text: 'Concurrent unread',
        now: MESSAGE_TIME_ONE,
      }),
      messagesRepository.markRead(conversationId, RECIPIENT_ID, BASE_TIME),
    ]);

    const member = await prisma.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_userId: {
          conversationId,
          userId: RECIPIENT_ID,
        },
      },
      select: { unreadCount: true, lastReadAt: true },
    });
    expect([0, 1]).toContain(member.unreadCount);
    if (member.unreadCount === 0) {
      expect(member.lastReadAt?.getTime()).toBeGreaterThanOrEqual(
        MESSAGE_TIME_ONE.getTime(),
      );
    } else {
      expect(member.lastReadAt).toEqual(BASE_TIME);
    }
  });

  it('resets unread state at the latest persisted message boundary', async () => {
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'First unread',
      MESSAGE_TIME_ONE,
    );
    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_TWO,
      'Second unread',
      MESSAGE_TIME_TWO,
    );
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(2);

    const result = await messagesRepository.markRead(
      conversationId,
      RECIPIENT_ID,
      BASE_TIME,
    );
    expect(result).toEqual({
      status: 'updated',
      state: {
        conversationId,
        lastReadAt: MESSAGE_TIME_TWO,
        unreadCount: 0,
      },
    });
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(0);

    await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_THREE,
      'Unread after reset',
      MESSAGE_TIME_THREE,
    );
    await expect(memberUnreadCount(RECIPIENT_ID)).resolves.toBe(1);
  });

  it('projects the latest message and actor-specific unread count in conversation summaries', async () => {
    const message = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Latest conversation summary',
      MESSAGE_TIME_ONE,
    );

    await expect(
      conversationsRepository.findForUser(conversationId, RECIPIENT_ID),
    ).resolves.toMatchObject({
      id: conversationId,
      latestMessage: {
        id: message.id,
        senderId: SENDER_ID,
        text: 'Latest conversation summary',
        createdAt: MESSAGE_TIME_ONE,
      },
      unreadCount: 1,
      lastActivityAt: MESSAGE_TIME_ONE,
    });
    await expect(
      conversationsRepository.findForUser(conversationId, SENDER_ID),
    ).resolves.toMatchObject({
      id: conversationId,
      latestMessage: { id: message.id },
      unreadCount: 0,
    });
  });

  it('keeps an incoming message archived while advancing its preview and unread count', async () => {
    await prisma.conversationMember.update({
      where: {
        conversationId_userId: {
          conversationId,
          userId: RECIPIENT_ID,
        },
      },
      data: { archivedAt: BASE_TIME },
    });

    const message = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Still archived',
      MESSAGE_TIME_ONE,
    );

    await expect(
      conversationsService.list(RECIPIENT_ID, 20),
    ).resolves.toMatchObject({ items: [] });
    await expect(
      conversationsService.listArchived(RECIPIENT_ID, 20),
    ).resolves.toMatchObject({
      items: [
        {
          id: conversationId,
          latestMessage: {
            id: message.id,
            preview: 'Still archived',
            createdAt: MESSAGE_TIME_ONE.toISOString(),
          },
          unreadCount: 1,
          settings: {
            archived: true,
            archivedAt: BASE_TIME.toISOString(),
          },
        },
      ],
    });
  });

  async function sendMessage(
    senderId: string,
    clientMessageId: string,
    text: string,
    now: Date,
  ): Promise<MessageRecord> {
    const result = await messagesRepository.sendText({
      conversationId,
      senderId,
      clientMessageId,
      text,
      now,
    });
    if (result.status !== 'created') {
      throw new Error(`Expected a created message, received ${result.status}.`);
    }
    return result.message;
  }

  async function memberUnreadCount(userId: string): Promise<number> {
    const member = await prisma.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId } },
      select: { unreadCount: true },
    });
    return member.unreadCount;
  }

  async function seedMessageImage(
    id: string,
    options: {
      ownerId?: string;
      status?: MediaStatus;
      mimeType?: 'image/jpeg' | 'image/png' | 'image/webp';
      byteSize?: number;
      width?: number;
      height?: number;
    } = {},
  ): Promise<void> {
    const ownerId = options.ownerId ?? SENDER_ID;
    const status = options.status ?? MediaStatus.READY;
    const mimeType = options.mimeType ?? 'image/jpeg';
    const format = mimeType.replace('image/', '').replace('jpeg', 'jpg');
    const isReady = status === MediaStatus.READY;
    await prisma.mediaAsset.create({
      data: {
        id,
        ownerId,
        clientUploadId: id.replace(/^2/, '3'),
        uploadFingerprint: id.replaceAll('-', '').padEnd(64, '0'),
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status,
        cloudinaryPublicId: `users/${ownerId}/message-images/${id}`,
        cloudinaryAssetId: isReady ? `cloudinary-${id}` : null,
        resourceType: 'image',
        deliveryType: 'upload',
        format: isReady ? format : null,
        mimeType,
        byteSize: options.byteSize ?? 50_000,
        width: isReady ? (options.width ?? 800) : null,
        height: isReady ? (options.height ?? 600) : null,
        secureUrl: isReady ? mediaUrl(id, format) : null,
        expiresAt: new Date('2026-08-13T16:30:00.000Z'),
        completedAt: isReady ? BASE_TIME : null,
        createdAt: BASE_TIME,
      },
    });
  }

  async function seedMessageAudio(
    id: string,
    options: {
      ownerId?: string;
      status?: MediaStatus;
      byteSize?: number;
      durationMs?: number;
    } = {},
  ): Promise<void> {
    const ownerId = options.ownerId ?? SENDER_ID;
    const status = options.status ?? MediaStatus.READY;
    const isReady = status === MediaStatus.READY;
    await prisma.mediaAsset.create({
      data: {
        id,
        ownerId,
        clientUploadId: id.replace(/^2/, '3'),
        uploadFingerprint: id.replaceAll('-', '').padEnd(64, '0'),
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status,
        cloudinaryPublicId: `users/${ownerId}/message-audio/${id}`,
        cloudinaryAssetId: isReady ? `cloudinary-${id}` : null,
        resourceType: 'video',
        deliveryType: 'upload',
        format: isReady ? 'm4a' : null,
        mimeType: 'audio/mp4',
        byteSize: options.byteSize ?? 482_310,
        width: null,
        height: null,
        durationMs: isReady ? (options.durationMs ?? 18_400) : null,
        secureUrl: isReady ? audioUrl(id) : null,
        expiresAt: new Date('2026-08-13T16:30:00.000Z'),
        completedAt: isReady ? BASE_TIME : null,
        createdAt: BASE_TIME,
      },
    });
  }

  function mediaUrl(id: string, format: string): string {
    return `https://res.cloudinary.com/classroom/image/upload/${id}.${format}`;
  }

  function audioUrl(id: string): string {
    return `https://res.cloudinary.com/classroom/video/upload/${id}.m4a`;
  }

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

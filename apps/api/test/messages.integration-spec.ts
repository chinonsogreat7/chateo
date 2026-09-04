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
    await prisma.conversationMember.updateMany({
      where: { conversationId },
      data: {
        unreadCount: 0,
        lastReadAt: null,
        archivedAt: null,
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

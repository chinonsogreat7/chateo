import { Clock } from '../src/auth/providers/clock';
import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
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
  let conversationId: string;
  let otherConversationId: string;

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

    const otherResult = await conversationsRepository.createOrGetDirect(
      SENDER_ID,
      OUTSIDER_ID,
      BASE_TIME,
    );
    if (otherResult.status === 'participant-not-found') {
      throw new Error('Seeded secondary conversation users were not found.');
    }
    otherConversationId = otherResult.conversation.id;
  });

  beforeEach(async () => {
    await prisma.message.deleteMany({
      where: { conversationId: { in: [conversationId, otherConversationId] } },
    });
    await prisma.conversationMember.updateMany({
      where: {
        conversationId: { in: [conversationId, otherConversationId] },
      },
      data: { unreadCount: 0, lastReadAt: null },
    });
    await prisma.conversation.updateMany({
      where: { id: { in: [conversationId, otherConversationId] } },
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

  it('persists and replays a same-conversation reply with a shallow history projection', async () => {
    const original = await sendMessage(
      SENDER_ID,
      CLIENT_MESSAGE_ONE,
      'Original message',
      MESSAGE_TIME_ONE,
    );
    const input = {
      conversationId,
      senderId: RECIPIENT_ID,
      clientMessageId: CLIENT_MESSAGE_TWO,
      replyToMessageId: original.id,
      text: 'Reply message',
      now: MESSAGE_TIME_TWO,
    };

    const created = await messagesRepository.sendText(input);
    expect(created).toMatchObject({
      status: 'created',
      message: {
        replyToMessageId: original.id,
        replyTo: {
          id: original.id,
          senderId: SENDER_ID,
          kind: 'TEXT',
          preview: 'Original message',
        },
      },
    });
    await expect(messagesRepository.sendText(input)).resolves.toMatchObject({
      status: 'existing',
      message: { replyToMessageId: original.id },
    });
    await expect(
      messagesRepository.sendText({ ...input, replyToMessageId: null }),
    ).resolves.toEqual({ status: 'idempotency-conflict' });

    const history = await messagesService.list(SENDER_ID, conversationId, 20);
    expect(history.items[0]).toMatchObject({
      text: 'Reply message',
      replyToMessageId: original.id,
      replyTo: {
        id: original.id,
        senderId: SENDER_ID,
        kind: 'text',
        preview: 'Original message',
      },
    });
    await expect(memberUnreadCount(SENDER_ID)).resolves.toBe(1);
  });

  it('conceals invalid reply targets and enforces the same-conversation relation in PostgreSQL', async () => {
    const otherTarget = await messagesRepository.sendText({
      conversationId: otherConversationId,
      senderId: SENDER_ID,
      clientMessageId: CLIENT_MESSAGE_ONE,
      text: 'Other conversation target',
      now: MESSAGE_TIME_ONE,
    });
    if (otherTarget.status !== 'created') {
      throw new Error(
        `Expected target creation, received ${otherTarget.status}.`,
      );
    }

    await expect(
      messagesRepository.sendText({
        conversationId,
        senderId: RECIPIENT_ID,
        clientMessageId: CLIENT_MESSAGE_TWO,
        replyToMessageId: otherTarget.message.id,
        text: 'Cross-conversation reply',
        now: MESSAGE_TIME_TWO,
      }),
    ).resolves.toEqual({ status: 'reply-message-not-found' });
    await expect(
      messagesRepository.sendText({
        conversationId,
        senderId: RECIPIENT_ID,
        clientMessageId: CLIENT_MESSAGE_THREE,
        replyToMessageId: '99999999-9999-4999-8999-999999999999',
        text: 'Missing reply',
        now: MESSAGE_TIME_THREE,
      }),
    ).resolves.toEqual({ status: 'reply-message-not-found' });

    await expect(
      prisma.message.create({
        data: {
          conversationId,
          senderId: RECIPIENT_ID,
          clientMessageId: CLIENT_MESSAGE_FOUR,
          replyToMessageId: otherTarget.message.id,
          text: 'Raw cross-conversation reply',
          createdAt: MESSAGE_TIME_FOUR,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.message.count({ where: { conversationId } }),
    ).resolves.toBe(0);
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

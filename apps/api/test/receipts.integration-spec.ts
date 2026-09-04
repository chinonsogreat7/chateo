import { PrismaConversationsRepository } from '../src/conversations/prisma-conversations.repository';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaMessagesRepository } from '../src/messages/prisma-messages.repository';
import type { MessageRecord } from '../src/messages/messages.types';
import { PrismaReceiptsRepository } from '../src/receipts/prisma-receipts.repository';
import type { ReceiptStatus } from '../src/receipts/receipts.types';

const ALICE_ID = '00000000-0000-4000-8000-000000000601';
const BOB_ID = '00000000-0000-4000-8000-000000000602';
const CAROL_ID = '00000000-0000-4000-8000-000000000603';
const USER_IDS = [ALICE_ID, BOB_ID, CAROL_ID];

const CLIENT_MESSAGE_ONE = '10000000-0000-4000-8000-000000000601';
const CLIENT_MESSAGE_TWO = '10000000-0000-4000-8000-000000000602';
const CLIENT_MESSAGE_THREE = '10000000-0000-4000-8000-000000000603';
const EQUAL_MESSAGE_LOW = '20000000-0000-4000-8000-000000000601';
const EQUAL_MESSAGE_HIGH = '20000000-0000-4000-8000-000000000602';

const BASE_TIME = new Date('2026-08-12T20:00:00.000Z');
const MESSAGE_TIME_ONE = new Date('2026-08-12T20:01:00.000Z');
const MESSAGE_TIME_TWO = new Date('2026-08-12T20:02:00.000Z');
const MESSAGE_TIME_THREE = new Date('2026-08-12T20:03:00.000Z');
const RECEIPT_TIME_ONE = new Date('2026-08-12T20:10:00.000Z');
const RECEIPT_TIME_TWO = new Date('2026-08-12T20:11:00.000Z');

describe('Prisma persistent message receipts', () => {
  const prisma = new PrismaService();
  const conversationsRepository = new PrismaConversationsRepository(prisma);
  const messagesRepository = new PrismaMessagesRepository(prisma);
  const receiptsRepository = new PrismaReceiptsRepository(prisma);
  let conversationId: string;
  let secondConversationId: string;

  beforeAll(async () => {
    await cleanupUsers();
    await prisma.user.createMany({
      data: [
        {
          id: ALICE_ID,
          phoneNumber: '+12025550301',
          phoneVerifiedAt: BASE_TIME,
          displayName: 'Receipt Alice',
          profileCompletedAt: BASE_TIME,
        },
        {
          id: BOB_ID,
          phoneNumber: '+12025550302',
          phoneVerifiedAt: BASE_TIME,
          displayName: 'Receipt Bob',
          profileCompletedAt: BASE_TIME,
        },
        {
          id: CAROL_ID,
          phoneNumber: '+12025550303',
          phoneVerifiedAt: BASE_TIME,
          displayName: 'Receipt Carol',
          profileCompletedAt: BASE_TIME,
        },
      ],
    });

    const first = await conversationsRepository.createOrGetDirect(
      ALICE_ID,
      BOB_ID,
      BASE_TIME,
    );
    const second = await conversationsRepository.createOrGetDirect(
      ALICE_ID,
      CAROL_ID,
      BASE_TIME,
    );
    if (
      first.status === 'participant-not-found' ||
      second.status === 'participant-not-found'
    ) {
      throw new Error('Seeded receipt integration users were not found.');
    }
    conversationId = first.conversation.id;
    secondConversationId = second.conversation.id;
  });

  beforeEach(async () => {
    await prisma.message.deleteMany({
      where: { conversationId: { in: [conversationId, secondConversationId] } },
    });
    await prisma.conversationMember.updateMany({
      where: { conversationId: { in: [conversationId, secondConversationId] } },
      data: {
        unreadCount: 0,
        lastReadAt: null,
        receiptVersion: 0,
        clearedAt: null,
        clearedThroughMessageId: null,
      },
    });
  });

  afterAll(async () => {
    await cleanupUsers();
    await prisma.$disconnect();
  });

  it('makes read imply delivery and reconciles durable participant frontiers', async () => {
    await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'First unread',
      MESSAGE_TIME_ONE,
    );
    const second = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_TWO,
      'Second unread',
      MESSAGE_TIME_TWO,
    );

    const result = await mark(
      conversationId,
      BOB_ID,
      second.id,
      'READ',
      RECEIPT_TIME_ONE,
    );
    expect(result).toMatchObject({
      status: 'updated',
      changed: true,
      receipt: {
        conversationId,
        userId: BOB_ID,
        status: 'READ',
        throughMessageId: second.id,
        at: RECEIPT_TIME_ONE,
        version: 1,
        unreadCount: 0,
        delivered: {
          messageId: second.id,
          at: RECEIPT_TIME_ONE,
        },
        read: { messageId: second.id, at: RECEIPT_TIME_ONE },
      },
    });

    const rows = await prisma.messageReceipt.findMany({
      where: { conversationId, userId: BOB_ID },
      orderBy: { messageId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          deliveredAt: RECEIPT_TIME_ONE,
          readAt: RECEIPT_TIME_ONE,
        }),
        expect.objectContaining({
          deliveredAt: RECEIPT_TIME_ONE,
          readAt: RECEIPT_TIME_ONE,
        }),
      ]),
    );
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(0);

    await expect(
      receiptsRepository.listForMember(conversationId, ALICE_ID),
    ).resolves.toEqual({
      status: 'found',
      conversationId,
      frontiers: [
        { userId: ALICE_ID, version: 0, delivered: null, read: null },
        {
          userId: BOB_ID,
          version: 1,
          delivered: {
            messageId: second.id,
            at: RECEIPT_TIME_ONE,
          },
          read: { messageId: second.id, at: RECEIPT_TIME_ONE },
        },
      ],
    });
  });

  it('uses message UUID as the receipt boundary tie-breaker at equal timestamps', async () => {
    await createRawMessage(
      EQUAL_MESSAGE_LOW,
      CLIENT_MESSAGE_ONE,
      MESSAGE_TIME_ONE,
    );
    await createRawMessage(
      EQUAL_MESSAGE_HIGH,
      CLIENT_MESSAGE_TWO,
      MESSAGE_TIME_ONE,
    );

    const low = await mark(
      conversationId,
      BOB_ID,
      EQUAL_MESSAGE_LOW,
      'DELIVERED',
      RECEIPT_TIME_ONE,
    );
    expect(low).toMatchObject({
      status: 'updated',
      changed: true,
      receipt: { throughMessageId: EQUAL_MESSAGE_LOW, version: 1 },
    });
    await expect(
      prisma.messageReceipt.count({
        where: { conversationId, userId: BOB_ID },
      }),
    ).resolves.toBe(1);

    const high = await mark(
      conversationId,
      BOB_ID,
      EQUAL_MESSAGE_HIGH,
      'DELIVERED',
      RECEIPT_TIME_TWO,
    );
    expect(high).toMatchObject({
      status: 'updated',
      changed: true,
      receipt: { throughMessageId: EQUAL_MESSAGE_HIGH, version: 2 },
    });
    await expect(
      prisma.messageReceipt.count({
        where: { conversationId, userId: BOB_ID },
      }),
    ).resolves.toBe(2);
  });

  it('preserves the first transition timestamp on duplicate and older advances', async () => {
    const first = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'First',
      MESSAGE_TIME_ONE,
    );
    const second = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_TWO,
      'Second',
      MESSAGE_TIME_TWO,
    );

    await expect(
      mark(conversationId, BOB_ID, second.id, 'DELIVERED', RECEIPT_TIME_ONE),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      receipt: {
        throughMessageId: second.id,
        at: RECEIPT_TIME_ONE,
        version: 1,
      },
    });
    for (const boundary of [second.id, first.id]) {
      await expect(
        mark(conversationId, BOB_ID, boundary, 'DELIVERED', RECEIPT_TIME_TWO),
      ).resolves.toMatchObject({
        status: 'updated',
        changed: false,
        receipt: {
          throughMessageId: second.id,
          at: RECEIPT_TIME_ONE,
          version: 1,
        },
      });
    }
  });

  it('returns both full frontiers when read and delivery advance independently', async () => {
    const first = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'Read frontier',
      MESSAGE_TIME_ONE,
    );
    const second = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_TWO,
      'Delivery frontier',
      MESSAGE_TIME_TWO,
    );

    await mark(
      conversationId,
      BOB_ID,
      second.id,
      'DELIVERED',
      RECEIPT_TIME_ONE,
    );
    const read = await mark(
      conversationId,
      BOB_ID,
      first.id,
      'READ',
      RECEIPT_TIME_TWO,
    );

    expect(read).toMatchObject({
      status: 'updated',
      changed: true,
      receipt: {
        version: 2,
        throughMessageId: first.id,
        delivered: { messageId: second.id, at: RECEIPT_TIME_ONE },
        read: { messageId: first.id, at: RECEIPT_TIME_TWO },
      },
    });
  });

  it('converges concurrent advances to the maximum receipt frontier', async () => {
    const first = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'Concurrent one',
      MESSAGE_TIME_ONE,
    );
    await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_TWO,
      'Concurrent two',
      MESSAGE_TIME_TWO,
    );
    const third = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_THREE,
      'Concurrent three',
      MESSAGE_TIME_THREE,
    );

    const results = await Promise.all([
      mark(conversationId, BOB_ID, first.id, 'DELIVERED', RECEIPT_TIME_ONE),
      mark(conversationId, BOB_ID, third.id, 'DELIVERED', RECEIPT_TIME_ONE),
    ]);
    expect(results.every((result) => result.status === 'updated')).toBe(true);
    expect(
      results.some((result) => result.status === 'updated' && result.changed),
    ).toBe(true);
    await expect(
      prisma.messageReceipt.count({
        where: { conversationId, userId: BOB_ID },
      }),
    ).resolves.toBe(3);
    const member = await prisma.conversationMember.findUniqueOrThrow({
      where: {
        conversationId_userId: { conversationId, userId: BOB_ID },
      },
      select: { receiptVersion: true },
    });
    expect(member.receiptVersion).toBeGreaterThanOrEqual(1);
    expect(member.receiptVersion).toBeLessThanOrEqual(2);
    await expect(
      receiptsRepository.listForMember(conversationId, BOB_ID),
    ).resolves.toMatchObject({
      status: 'found',
      frontiers: expect.arrayContaining([
        expect.objectContaining({
          userId: BOB_ID,
          version: member.receiptVersion,
          delivered: expect.objectContaining({ messageId: third.id }),
        }),
      ]),
    });
  });

  it('keeps unread count accurate across partial, newer, and older reads', async () => {
    const first = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'Unread one',
      MESSAGE_TIME_ONE,
    );
    const second = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_TWO,
      'Unread two',
      MESSAGE_TIME_TWO,
    );
    const third = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_THREE,
      'Unread three',
      MESSAGE_TIME_THREE,
    );
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(3);

    await expect(
      mark(conversationId, BOB_ID, second.id, 'READ', RECEIPT_TIME_ONE),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      receipt: { throughMessageId: second.id, version: 1, unreadCount: 1 },
    });
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(1);

    await expect(
      mark(conversationId, BOB_ID, third.id, 'READ', RECEIPT_TIME_TWO),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      receipt: { throughMessageId: third.id, version: 2, unreadCount: 0 },
    });
    await expect(
      mark(
        conversationId,
        BOB_ID,
        first.id,
        'READ',
        new Date(RECEIPT_TIME_TWO.getTime() + 60_000),
      ),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: false,
      receipt: { throughMessageId: third.id, version: 2, unreadCount: 0 },
    });
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(0);
  });

  it('rejects cleared receipt boundaries without reviving unread messages', async () => {
    const first = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'Cleared receipt one',
      MESSAGE_TIME_ONE,
    );
    const second = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_TWO,
      'Cleared receipt two',
      MESSAGE_TIME_TWO,
    );
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(2);

    await expect(
      messagesRepository.clearForMember(
        conversationId,
        BOB_ID,
        RECEIPT_TIME_ONE,
      ),
    ).resolves.toMatchObject({
      status: 'cleared',
      changed: true,
      clearedAt: MESSAGE_TIME_TWO,
      clearedThroughMessageId: second.id,
    });
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(0);

    for (const clearedMessage of [first, second]) {
      await expect(
        mark(
          conversationId,
          BOB_ID,
          clearedMessage.id,
          'READ',
          RECEIPT_TIME_TWO,
        ),
      ).resolves.toEqual({ status: 'conversation-not-found' });
    }
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(0);
    await expect(
      prisma.messageReceipt.count({
        where: { conversationId, userId: BOB_ID },
      }),
    ).resolves.toBe(0);

    const next = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_THREE,
      'Receipt after clear',
      MESSAGE_TIME_THREE,
    );
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(1);
    await expect(
      mark(conversationId, BOB_ID, first.id, 'READ', RECEIPT_TIME_TWO),
    ).resolves.toEqual({ status: 'conversation-not-found' });
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(1);
    await expect(
      mark(conversationId, BOB_ID, next.id, 'READ', RECEIPT_TIME_TWO),
    ).resolves.toMatchObject({
      status: 'updated',
      changed: true,
      receipt: { throughMessageId: next.id, unreadCount: 0 },
    });
    await expect(memberUnreadCount(BOB_ID)).resolves.toBe(0);
  });

  it('conceals outsiders, sender-owned messages, and wrong-conversation boundaries', async () => {
    const incoming = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'Incoming',
      MESSAGE_TIME_ONE,
    );
    const senderOwned = await sendMessage(
      conversationId,
      BOB_ID,
      CLIENT_MESSAGE_TWO,
      'Sender owned',
      MESSAGE_TIME_TWO,
    );
    const wrongConversation = await sendMessage(
      secondConversationId,
      ALICE_ID,
      CLIENT_MESSAGE_THREE,
      'Wrong conversation',
      MESSAGE_TIME_THREE,
    );

    const results = await Promise.all([
      mark(
        conversationId,
        CAROL_ID,
        incoming.id,
        'DELIVERED',
        RECEIPT_TIME_ONE,
      ),
      mark(conversationId, BOB_ID, senderOwned.id, 'READ', RECEIPT_TIME_ONE),
      mark(
        conversationId,
        BOB_ID,
        wrongConversation.id,
        'DELIVERED',
        RECEIPT_TIME_ONE,
      ),
      receiptsRepository.listForMember(conversationId, CAROL_ID),
    ]);
    expect(results).toEqual([
      { status: 'conversation-not-found' },
      { status: 'conversation-not-found' },
      { status: 'conversation-not-found' },
      { status: 'conversation-not-found' },
    ]);
    await expect(
      prisma.messageReceipt.count({ where: { conversationId } }),
    ).resolves.toBe(0);
  });

  it('enforces receipt membership, message-conversation, and timestamp constraints in PostgreSQL', async () => {
    const message = await sendMessage(
      conversationId,
      ALICE_ID,
      CLIENT_MESSAGE_ONE,
      'Constraint target',
      MESSAGE_TIME_ONE,
    );

    await expect(
      prisma.messageReceipt.create({
        data: {
          messageId: message.id,
          conversationId,
          userId: CAROL_ID,
          deliveredAt: RECEIPT_TIME_ONE,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.messageReceipt.create({
        data: {
          messageId: message.id,
          conversationId: secondConversationId,
          userId: CAROL_ID,
          deliveredAt: RECEIPT_TIME_ONE,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await expect(
      prisma.messageReceipt.create({
        data: {
          messageId: message.id,
          conversationId,
          userId: BOB_ID,
          deliveredAt: RECEIPT_TIME_TWO,
          readAt: RECEIPT_TIME_ONE,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.messageReceipt.count({ where: { messageId: message.id } }),
    ).resolves.toBe(0);
  });

  function mark(
    targetConversationId: string,
    userId: string,
    throughMessageId: string,
    status: ReceiptStatus,
    now: Date,
  ) {
    return receiptsRepository.markThrough({
      conversationId: targetConversationId,
      userId,
      throughMessageId,
      status,
      now,
    });
  }

  async function sendMessage(
    targetConversationId: string,
    senderId: string,
    clientMessageId: string,
    text: string,
    now: Date,
  ): Promise<MessageRecord> {
    const result = await messagesRepository.sendText({
      conversationId: targetConversationId,
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

  async function createRawMessage(
    id: string,
    clientMessageId: string,
    createdAt: Date,
  ): Promise<void> {
    await prisma.message.create({
      data: {
        id,
        conversationId,
        senderId: ALICE_ID,
        clientMessageId,
        text: 'Equal timestamp boundary',
        createdAt,
      },
    });
  }

  async function memberUnreadCount(userId: string): Promise<number> {
    const member = await prisma.conversationMember.findUniqueOrThrow({
      where: { conversationId_userId: { conversationId, userId } },
      select: { unreadCount: true },
    });
    return member.unreadCount;
  }

  async function cleanupUsers(): Promise<void> {
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

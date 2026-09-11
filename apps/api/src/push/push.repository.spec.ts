import { PrismaService } from '../database/prisma.service';
import { PushRepository, type LeasedPush } from './push.repository';
import { enqueueMessagePush } from './push-outbox';
import { Prisma } from '@prisma/client';

const NOW = new Date('2026-09-11T12:00:00Z');
const work = {
  id: 'job',
  messageId: 'message',
  deviceId: 'device',
  deviceVersion: 1,
  createdAt: NOW,
  leaseToken: 'lease',
} as LeasedPush;
function fixture() {
  const member = {
    userId: 'recipient',
    joinedAt: new Date(NOW.getTime() - 1000),
    mutedAt: null as Date | null,
    mutedUntil: null as Date | null,
    clearedAt: null as Date | null,
    clearedThroughMessageId: null as string | null,
  };
  const device = {
    id: 'device',
    userId: 'recipient',
    token: 'secret',
    tokenHash: 'hash',
    familyId: 'family',
    platform: 'IOS',
    version: 1,
    registeredAt: NOW,
    disabledAt: null as Date | null,
  };
  const message = {
    id: 'message',
    conversationId: 'chat',
    senderId: 'sender',
    createdAt: NOW,
    deletedAt: null as Date | null,
    receipts: [] as Array<{ messageId: string }>,
    conversation: {
      type: 'DIRECT',
      members: [member, { ...member, userId: 'sender' }],
    },
  };
  const tx = {
    pushDevice: {
      findUnique: jest.fn().mockResolvedValue(device),
      findMany: jest.fn().mockResolvedValue([device]),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn().mockResolvedValue(device),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    authSession: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: 'session', familyId: 'family' }),
      findMany: jest
        .fn()
        .mockResolvedValue([{ userId: 'recipient', familyId: 'family' }]),
    },
    message: { findUnique: jest.fn().mockResolvedValue(message) },
    conversationMember: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ unreadCount: 1, lastReadAt: null }),
      findMany: jest.fn().mockResolvedValue([member]),
    },
    userBlock: { findFirst: jest.fn().mockResolvedValue(null) },
    pushNotification: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      createMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(
      async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx),
    ),
  } as unknown as PrismaService;
  return {
    member,
    device,
    message,
    tx,
    prisma,
    repository: new PushRepository(prisma),
  };
}
describe('Push persistence and policy', () => {
  it('queues only registered active-family recipients atomically, excluding muted users', async () => {
    const { tx, member } = fixture();
    await enqueueMessagePush(
      tx as unknown as Prisma.TransactionClient,
      { id: 'message', conversationId: 'chat', senderId: 'sender' },
      NOW,
      15,
    );
    expect(tx.pushNotification.createMany).toHaveBeenCalledWith({
      data: [
        {
          messageId: 'message',
          deviceId: 'device',
          deviceVersion: 1,
          createdAt: NOW,
          nextAttemptAt: new Date(NOW.getTime() + 15000),
        },
      ],
      skipDuplicates: true,
    });
    expect(tx.conversationMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { conversationId: 'chat', userId: { not: 'sender' } },
      }),
    );
    member.mutedAt = NOW;
    member.mutedUntil = null;
    tx.pushNotification.createMany.mockClear();
    await enqueueMessagePush(
      tx as unknown as Prisma.TransactionClient,
      { id: 'message', conversationId: 'chat', senderId: 'sender' },
      NOW,
      15,
    );
    expect(tx.pushNotification.createMany).not.toHaveBeenCalled();
  });
  it.each([
    'disabled',
    'rotated',
    'expired registration',
    'logged out',
    'deleted',
    'read',
    'cleared',
    'muted forever',
    'muted temporarily',
    'blocked',
    'removed',
    'rejoined',
  ])('suppresses a notification when %s', async (reason) => {
    const { repository, device, member, message, tx } = fixture();
    if (reason === 'disabled') device.disabledAt = NOW;
    if (reason === 'rotated') device.version += 1;
    if (reason === 'expired registration')
      device.registeredAt = new Date('2026-01-01');
    if (reason === 'logged out')
      tx.authSession.findFirst.mockResolvedValue(null);
    if (reason === 'deleted') message.deletedAt = NOW;
    if (reason === 'read') message.receipts.push({ messageId: message.id });
    if (reason === 'cleared') {
      member.clearedAt = NOW;
      member.clearedThroughMessageId = message.id;
    }
    if (reason.startsWith('muted')) {
      member.mutedAt = NOW;
      member.mutedUntil =
        reason === 'muted forever' ? null : new Date(NOW.getTime() + 1000);
    }
    if (reason === 'blocked')
      tx.userBlock.findFirst.mockResolvedValue({ blockerId: 'recipient' });
    if (reason === 'removed')
      message.conversation.members = message.conversation.members.filter(
        (item) => item.userId !== 'recipient',
      );
    if (reason === 'rejoined') member.joinedAt = new Date(NOW.getTime() + 1);
    await expect(repository.eligible(work, NOW)).resolves.toBeNull();
  });
  it('allows expired mutes and does not apply direct-user blocking to shared groups', async () => {
    const { repository, member, message, tx } = fixture();
    member.mutedAt = NOW;
    member.mutedUntil = NOW;
    message.conversation.type = 'GROUP';
    tx.userBlock.findFirst.mockResolvedValue({ blockerId: 'recipient' });
    await expect(repository.eligible(work, NOW)).resolves.toEqual({
      userId: 'recipient',
      token: 'secret',
      messageId: 'message',
      conversationId: 'chat',
    });
    expect(tx.userBlock.findFirst).not.toHaveBeenCalled();
  });
  it('claims due jobs with compare-and-set leases and guards stale completions/invalidations', async () => {
    const { repository, tx } = fixture();
    tx.pushNotification.findMany.mockResolvedValue([
      { ...work, status: 'PENDING', attempts: 0 },
    ]);
    const [claimed] = await repository.claimDue(NOW);
    expect(claimed).toMatchObject({
      attempts: 1,
      leaseToken: expect.any(String),
    });
    expect(tx.pushNotification.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job',
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: NOW } }],
        }),
      }),
    );
    await repository.finish(claimed!, { status: 'SENT' });
    expect(tx.pushNotification.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'job', leaseToken: claimed!.leaseToken },
      data: { status: 'SENT', leaseToken: null, leaseUntil: null },
    });
    await repository.invalidateDevice(work, NOW);
    expect(tx.pushDevice.updateMany).toHaveBeenCalledWith({
      where: { id: 'device', version: 1 },
      data: {
        token: null,
        tokenHash: null,
        disabledAt: NOW,
        version: { increment: 1 },
      },
    });
  });
});

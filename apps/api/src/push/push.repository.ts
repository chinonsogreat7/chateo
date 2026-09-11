import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Prisma, type PushNotification } from '@prisma/client';
import { serializable } from '../common/serializable';
import { PrismaService } from '../database/prisma.service';
import { isMuted, clearedMessage, PUSH_DEVICE_MAX_AGE_MS } from './push-policy';
import type { RegisterPushDeviceDto } from './push.dto';

export type LeasedPush = PushNotification & { leaseToken: string };
export interface PushDelivery {
  userId: string;
  token: string;
  conversationId: string;
  messageId: string;
}

@Injectable()
export class PushRepository {
  constructor(private readonly prisma: PrismaService) {}

  async register(
    userId: string,
    sessionId: string,
    id: string,
    input: RegisterPushDeviceDto,
    now: Date,
  ) {
    return serializable(this.prisma, async (tx) => {
      const session = await tx.authSession.findFirst({
        where: {
          id: sessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { familyId: true },
      });
      if (!session) return { status: 'unauthorized' } as const;
      const tokenHash = createHash('sha256').update(input.token).digest('hex');
      const [current, previous, count] = await Promise.all([
        tx.pushDevice.findUnique({ where: { id } }),
        tx.pushDevice.findUnique({ where: { tokenHash } }),
        tx.pushDevice.count({
          where: {
            userId,
            id: { not: id },
            tokenHash: { not: tokenHash },
            disabledAt: null,
            registeredAt: {
              gt: new Date(now.getTime() - PUSH_DEVICE_MAX_AGE_MS),
            },
          },
        }),
      ]);
      if (
        current &&
        current.userId !== userId &&
        current.tokenHash !== tokenHash
      )
        return { status: 'unavailable' } as const;
      if (count >= 20) return { status: 'limit' } as const;
      // Tokens are secrets; knowing a token proves installation possession. A
      // new login can transfer it, but old jobs and receipts cannot target it.
      if (previous && previous.id !== id)
        await tx.pushDevice.update({
          where: { id: previous.id },
          data: {
            token: null,
            tokenHash: null,
            disabledAt: now,
            version: { increment: 1 },
          },
        });
      const changed =
        !current ||
        current.userId !== userId ||
        current.familyId !== session.familyId ||
        current.tokenHash !== tokenHash ||
        current.platform !== input.platform.toUpperCase() ||
        current.disabledAt !== null;
      const data = {
        userId,
        familyId: session.familyId,
        platform:
          input.platform === 'ios' ? ('IOS' as const) : ('ANDROID' as const),
        token: input.token,
        tokenHash,
        registeredAt: now,
        disabledAt: null,
      };
      const device = await tx.pushDevice.upsert({
        where: { id },
        create: { id, ...data },
        update: { ...data, ...(changed ? { version: { increment: 1 } } : {}) },
      });
      return {
        status: 'registered',
        device: {
          installationId: device.id,
          platform: input.platform,
          registeredAt: device.registeredAt.toISOString(),
        },
      } as const;
    });
  }

  async unregister(
    userId: string,
    sessionId: string,
    id: string,
    now: Date,
  ): Promise<void> {
    // Scope removal to this login family. An older still-signed-in installation
    // cannot disable a later login's registration after an account switch.
    await serializable(this.prisma, async (tx) => {
      const session = await tx.authSession.findFirst({
        where: {
          id: sessionId,
          userId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        select: { familyId: true },
      });
      if (!session) return;
      await tx.pushDevice.updateMany({
        where: { id, userId, familyId: session.familyId, disabledAt: null },
        data: {
          disabledAt: now,
          token: null,
          tokenHash: null,
          version: { increment: 1 },
        },
      });
    });
  }

  async claimDue(now: Date, limit = 20): Promise<LeasedPush[]> {
    const where = {
      status: { in: ['PENDING', 'RECEIPT'] as Array<'PENDING' | 'RECEIPT'> },
      nextAttemptAt: { lte: now },
      OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
    };
    const candidates = await this.prisma.pushNotification.findMany({
      where,
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    const claimed: LeasedPush[] = [];
    // Claim just a small batch; a worker processes it concurrently within its lease.
    for (const job of candidates) {
      const leaseToken = randomUUID();
      const leaseUntil = new Date(now.getTime() + 120000);
      const won = await this.prisma.pushNotification.updateMany({
        where: { ...where, id: job.id },
        data: {
          leaseToken,
          leaseUntil,
          ...(job.status === 'PENDING' ? { attempts: { increment: 1 } } : {}),
        },
      });
      if (won.count === 1)
        claimed.push({
          ...job,
          leaseToken,
          leaseUntil,
          attempts: job.attempts + (job.status === 'PENDING' ? 1 : 0),
        });
    }
    return claimed;
  }

  async eligible(job: LeasedPush, now: Date): Promise<PushDelivery | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const device = await tx.pushDevice.findUnique({
          where: { id: job.deviceId },
        });
        if (
          !device ||
          device.disabledAt ||
          !device.token ||
          device.version !== job.deviceVersion ||
          device.registeredAt.getTime() <=
            now.getTime() - PUSH_DEVICE_MAX_AGE_MS
        )
          return null;
        const session = await tx.authSession.findFirst({
          where: {
            userId: device.userId,
            familyId: device.familyId,
            revokedAt: null,
            expiresAt: { gt: now },
          },
          select: { id: true },
        });
        if (!session) return null;
        const message = await tx.message.findUnique({
          where: { id: job.messageId },
          select: {
            id: true,
            conversationId: true,
            senderId: true,
            deletedAt: true,
            createdAt: true,
            receipts: {
              where: { userId: device.userId, readAt: { not: null } },
              select: { messageId: true },
            },
            conversation: {
              select: {
                type: true,
                members: {
                  select: {
                    userId: true,
                    joinedAt: true,
                    mutedAt: true,
                    mutedUntil: true,
                    clearedAt: true,
                    clearedThroughMessageId: true,
                  },
                },
              },
            },
          },
        });
        if (
          !message ||
          message.deletedAt ||
          message.senderId === device.userId ||
          message.receipts.length > 0
        )
          return null;
        const member = message.conversation.members.find(
          (item) => item.userId === device.userId,
        );
        if (
          !member ||
          member.joinedAt > job.createdAt ||
          isMuted(member, now) ||
          clearedMessage(member, message) ||
          !message.conversation.members.some(
            (item) => item.userId === message.senderId,
          )
        )
          return null;
        // Legacy mark-read clears unreadCount and lastReadAt; durable receipts are
        // checked above instead of comparing their event time to message time.
        const readState = await tx.conversationMember.findUnique({
          where: {
            conversationId_userId: {
              conversationId: message.conversationId,
              userId: device.userId,
            },
          },
          select: { unreadCount: true, lastReadAt: true },
        });
        if (
          readState?.unreadCount === 0 &&
          readState.lastReadAt &&
          readState.lastReadAt >= message.createdAt
        )
          return null;
        if (message.conversation.type === 'DIRECT') {
          const block = await tx.userBlock.findFirst({
            where: {
              OR: [
                { blockerId: device.userId, blockedId: message.senderId },
                { blockerId: message.senderId, blockedId: device.userId },
              ],
            },
            select: { blockerId: true },
          });
          if (block) return null;
        }
        return {
          userId: device.userId,
          token: device.token,
          messageId: message.id,
          conversationId: message.conversationId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async finish(
    job: LeasedPush,
    data: Prisma.PushNotificationUpdateManyMutationInput,
  ): Promise<void> {
    await this.prisma.pushNotification.updateMany({
      where: { id: job.id, leaseToken: job.leaseToken },
      data: { ...data, leaseToken: null, leaseUntil: null },
    });
  }

  async ownsLease(job: LeasedPush, now: Date): Promise<boolean> {
    return (
      (await this.prisma.pushNotification.count({
        where: {
          id: job.id,
          leaseToken: job.leaseToken,
          leaseUntil: { gt: now },
        },
      })) === 1
    );
  }

  async invalidateDevice(job: LeasedPush, now: Date): Promise<void> {
    await this.prisma.pushDevice.updateMany({
      where: { id: job.deviceId, version: job.deviceVersion },
      data: {
        token: null,
        tokenHash: null,
        disabledAt: now,
        version: { increment: 1 },
      },
    });
  }
}

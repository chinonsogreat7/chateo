import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  type MarkReceiptThroughInput,
  ReceiptsRepository,
} from './receipts.repository';
import type {
  ListReceiptFrontiersResult,
  MarkReceiptResult,
  ReceiptFrontierRecord,
  ReceiptStatus,
} from './receipts.types';

interface ChangedReceiptRow {
  messageId: string;
}

interface EffectiveReceiptRow {
  messageId: string;
  deliveredAt: Date;
  readAt: Date | null;
  message: { createdAt: Date };
}

@Injectable()
export class PrismaReceiptsRepository extends ReceiptsRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async markThrough(
    input: MarkReceiptThroughInput,
  ): Promise<MarkReceiptResult> {
    const normalizedInput: MarkReceiptThroughInput = {
      ...input,
      conversationId: input.conversationId.toLowerCase(),
      userId: input.userId.toLowerCase(),
      throughMessageId: input.throughMessageId.toLowerCase(),
    };
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) =>
            this.markInTransaction(transaction, normalizedInput),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        const retryable = this.isRetryableTransactionError(error);
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async listForMember(
    conversationId: string,
    userId: string,
  ): Promise<ListReceiptFrontiersResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: normalizedConversationId,
        members: { some: { userId: normalizedUserId } },
      },
      select: {
        members: {
          select: {
            userId: true,
            receiptVersion: true,
            messageReceipts: {
              select: {
                messageId: true,
                deliveredAt: true,
                readAt: true,
                message: { select: { createdAt: true } },
              },
              orderBy: [
                { message: { createdAt: 'desc' } },
                { messageId: 'desc' },
              ],
            },
          },
          orderBy: { userId: 'asc' },
        },
      },
    });
    if (!conversation) {
      return { status: 'conversation-not-found' };
    }

    const frontiers = new Map<string, ReceiptFrontierRecord>(
      conversation.members.map(({ userId: memberId, receiptVersion }) => [
        memberId,
        {
          userId: memberId,
          version: receiptVersion,
          delivered: null,
          read: null,
        },
      ]),
    );

    for (const member of conversation.members) {
      const frontier = frontiers.get(member.userId);
      if (!frontier) continue;
      for (const receipt of member.messageReceipts) {
        frontier.delivered ??= {
          messageId: receipt.messageId,
          at: receipt.deliveredAt,
        };
        if (receipt.readAt && !frontier.read) {
          frontier.read = {
            messageId: receipt.messageId,
            at: receipt.readAt,
          };
        }
      }
    }

    return {
      status: 'found',
      conversationId: normalizedConversationId,
      frontiers: [...frontiers.values()],
    };
  }

  private async markInTransaction(
    transaction: Prisma.TransactionClient,
    input: MarkReceiptThroughInput,
  ): Promise<MarkReceiptResult> {
    const membership = await transaction.conversationMember.findUnique({
      where: {
        conversationId_userId: {
          conversationId: input.conversationId,
          userId: input.userId,
        },
      },
      select: {
        joinedAt: true,
        clearedAt: true,
        clearedThroughMessageId: true,
        lastReadAt: true,
        unreadCount: true,
        receiptVersion: true,
      },
    });
    if (!membership) return { status: 'conversation-not-found' };

    // The boundary itself must be an incoming message visible to this member.
    // Returning the same result for all failures avoids exposing conversation or
    // message existence to an unauthorized caller.
    const boundary = await transaction.message.findFirst({
      where: {
        id: input.throughMessageId,
        conversationId: input.conversationId,
        senderId: { not: input.userId },
        AND: [
          { createdAt: { gte: membership.joinedAt } },
          ...(membership.clearedAt && membership.clearedThroughMessageId
            ? [
                {
                  OR: [
                    { createdAt: { gt: membership.clearedAt } },
                    {
                      createdAt: membership.clearedAt,
                      id: { gt: membership.clearedThroughMessageId },
                    },
                  ],
                },
              ]
            : []),
        ],
      },
      select: { id: true, createdAt: true },
    });
    if (!boundary) return { status: 'conversation-not-found' };

    const previous = await this.findEffectiveReceipt(transaction, input);
    if (input.status === 'READ') {
      await this.markReadRows(
        transaction,
        input,
        boundary.createdAt,
        membership.joinedAt,
        membership.clearedAt,
        membership.clearedThroughMessageId,
      );
    } else {
      await this.markDeliveredRows(
        transaction,
        input,
        boundary.createdAt,
        membership.joinedAt,
        membership.clearedAt,
        membership.clearedThroughMessageId,
      );
    }

    const effective = await this.findEffectiveReceipt(transaction, input);
    if (!effective) {
      throw new Error('Receipt write completed without an effective boundary.');
    }
    const changed = this.frontierAdvanced(previous, effective);

    let unreadCount = membership.unreadCount;
    let version = membership.receiptVersion;
    if (input.status === 'READ') {
      unreadCount = await transaction.message.count({
        where: {
          conversationId: input.conversationId,
          senderId: { not: input.userId },
          AND: [
            { createdAt: { gte: membership.joinedAt } },
            ...(membership.clearedAt && membership.clearedThroughMessageId
              ? [
                  {
                    OR: [
                      { createdAt: { gt: membership.clearedAt } },
                      {
                        createdAt: membership.clearedAt,
                        id: { gt: membership.clearedThroughMessageId },
                      },
                    ],
                  },
                ]
              : []),
          ],
          receipts: {
            none: { userId: input.userId, readAt: { not: null } },
          },
        },
      });
      const readAt = effective.readAt;
      if (!readAt) {
        throw new Error('Effective read receipt is missing its timestamp.');
      }
      const updated = await transaction.conversationMember.update({
        where: {
          conversationId_userId: {
            conversationId: input.conversationId,
            userId: input.userId,
          },
        },
        data: {
          unreadCount,
          lastReadAt: this.latestDate(membership.lastReadAt, readAt),
          ...(changed ? { receiptVersion: { increment: 1 } } : {}),
        },
        select: { receiptVersion: true },
      });
      version = updated.receiptVersion;
    } else if (changed) {
      const updated = await transaction.conversationMember.update({
        where: {
          conversationId_userId: {
            conversationId: input.conversationId,
            userId: input.userId,
          },
        },
        data: { receiptVersion: { increment: 1 } },
        select: { receiptVersion: true },
      });
      version = updated.receiptVersion;
    }

    const members = await transaction.conversationMember.findMany({
      where: { conversationId: input.conversationId },
      select: { userId: true },
    });
    const at =
      input.status === 'READ' ? effective.readAt : effective.deliveredAt;
    if (!at) throw new Error('Effective receipt is missing its timestamp.');
    const deliveredEffective =
      input.status === 'DELIVERED'
        ? effective
        : await this.findEffectiveReceipt(transaction, input, 'DELIVERED');
    const readEffective =
      input.status === 'READ'
        ? effective
        : await this.findEffectiveReceipt(transaction, input, 'READ');
    if (!deliveredEffective) {
      throw new Error('Effective delivery receipt is missing.');
    }

    return {
      status: 'updated',
      changed,
      receipt: {
        conversationId: input.conversationId,
        userId: input.userId,
        status: input.status,
        throughMessageId: effective.messageId,
        at,
        version,
        delivered: {
          messageId: deliveredEffective.messageId,
          at: deliveredEffective.deliveredAt,
        },
        read:
          readEffective?.readAt != null
            ? {
                messageId: readEffective.messageId,
                at: readEffective.readAt,
              }
            : null,
        unreadCount,
        participantIds: [...new Set(members.map(({ userId }) => userId))],
      },
    };
  }

  private findEffectiveReceipt(
    transaction: Prisma.TransactionClient,
    input: MarkReceiptThroughInput,
    status: ReceiptStatus = input.status,
  ): Promise<EffectiveReceiptRow | null> {
    return transaction.messageReceipt.findFirst({
      where: {
        conversationId: input.conversationId,
        userId: input.userId,
        ...(status === 'READ' ? { readAt: { not: null } } : {}),
      },
      select: {
        messageId: true,
        deliveredAt: true,
        readAt: true,
        message: { select: { createdAt: true } },
      },
      orderBy: [{ message: { createdAt: 'desc' } }, { messageId: 'desc' }],
    });
  }

  private frontierAdvanced(
    previous: EffectiveReceiptRow | null,
    effective: EffectiveReceiptRow,
  ): boolean {
    if (!previous) return true;
    const timeDifference =
      effective.message.createdAt.getTime() -
      previous.message.createdAt.getTime();
    return (
      timeDifference > 0 ||
      (timeDifference === 0 && effective.messageId > previous.messageId)
    );
  }

  private markDeliveredRows(
    transaction: Prisma.TransactionClient,
    input: MarkReceiptThroughInput,
    boundaryCreatedAt: Date,
    joinedAt: Date,
    clearedAt: Date | null,
    clearedThroughMessageId: string | null,
  ): Promise<ChangedReceiptRow[]> {
    const clearedBoundary =
      clearedAt && clearedThroughMessageId
        ? Prisma.sql`AND (
          m."created_at" > ${clearedAt}
          OR (
            m."created_at" = ${clearedAt}
            AND m."id" > ${clearedThroughMessageId}::uuid
          )
        )`
        : Prisma.empty;
    return transaction.$queryRaw<ChangedReceiptRow[]>(Prisma.sql`
      INSERT INTO "message_receipts" (
        "message_id", "conversation_id", "user_id", "delivered_at"
      )
      SELECT
        m."id", m."conversation_id", ${input.userId}::uuid, ${input.now}
      FROM "messages" AS m
      WHERE m."conversation_id" = ${input.conversationId}::uuid
        AND m."sender_id" <> ${input.userId}::uuid
        AND m."created_at" >= ${joinedAt}
        ${clearedBoundary}
        AND (
          m."created_at" < ${boundaryCreatedAt}
          OR (
            m."created_at" = ${boundaryCreatedAt}
            AND m."id" <= ${input.throughMessageId}::uuid
          )
        )
      ON CONFLICT ("message_id", "user_id") DO NOTHING
      RETURNING "message_id" AS "messageId"
    `);
  }

  private markReadRows(
    transaction: Prisma.TransactionClient,
    input: MarkReceiptThroughInput,
    boundaryCreatedAt: Date,
    joinedAt: Date,
    clearedAt: Date | null,
    clearedThroughMessageId: string | null,
  ): Promise<ChangedReceiptRow[]> {
    const clearedBoundary =
      clearedAt && clearedThroughMessageId
        ? Prisma.sql`AND (
          m."created_at" > ${clearedAt}
          OR (
            m."created_at" = ${clearedAt}
            AND m."id" > ${clearedThroughMessageId}::uuid
          )
        )`
        : Prisma.empty;
    return transaction.$queryRaw<ChangedReceiptRow[]>(Prisma.sql`
      INSERT INTO "message_receipts" (
        "message_id", "conversation_id", "user_id", "delivered_at", "read_at"
      )
      SELECT
        m."id", m."conversation_id", ${input.userId}::uuid,
        ${input.now}, ${input.now}
      FROM "messages" AS m
      WHERE m."conversation_id" = ${input.conversationId}::uuid
        AND m."sender_id" <> ${input.userId}::uuid
        AND m."created_at" >= ${joinedAt}
        ${clearedBoundary}
        AND (
          m."created_at" < ${boundaryCreatedAt}
          OR (
            m."created_at" = ${boundaryCreatedAt}
            AND m."id" <= ${input.throughMessageId}::uuid
          )
        )
      ON CONFLICT ("message_id", "user_id") DO UPDATE
      SET "read_at" = GREATEST(
        "message_receipts"."delivered_at",
        EXCLUDED."read_at"
      )
      WHERE "message_receipts"."read_at" IS NULL
      RETURNING "message_id" AS "messageId"
    `);
  }

  private latestDate(first: Date | null, second: Date): Date {
    return first && first.getTime() > second.getTime() ? first : second;
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }

  private isRetryableTransactionError(error: unknown): boolean {
    if (this.prismaErrorCode(error) === 'P2034') return true;
    if (!error || typeof error !== 'object') return false;

    const candidate = error as {
      code?: unknown;
      meta?: { code?: unknown; message?: unknown };
    };
    if (candidate.code !== 'P2010') return false;
    const databaseCode = candidate.meta?.code;
    if (databaseCode === '40001' || databaseCode === '40P01') return true;

    const message = candidate.meta?.message;
    return (
      typeof message === 'string' &&
      /(?:SQLSTATE\s*)?(?:40001|40P01)/i.test(message)
    );
  }
}

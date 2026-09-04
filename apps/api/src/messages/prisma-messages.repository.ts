import { Injectable } from '@nestjs/common';
import { MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  MessagesRepository,
  type SendTextMessageInput,
} from './messages.repository';
import type {
  ClearConversationMessagesResult,
  ListMessagesResult,
  MarkConversationReadResult,
  MessagePageCursor,
  MessageRecord,
  SendTextMessageResult,
} from './messages.types';

const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  kind: true,
  text: true,
  createdAt: true,
} satisfies Prisma.MessageSelect;

type SelectedMessage = Prisma.MessageGetPayload<{
  select: typeof messageSelect;
}>;

@Injectable()
export class PrismaMessagesRepository extends MessagesRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async sendText(input: SendTextMessageInput): Promise<SendTextMessageResult> {
    const normalizedInput: SendTextMessageInput = {
      ...input,
      conversationId: input.conversationId.toLowerCase(),
      senderId: input.senderId.toLowerCase(),
      clientMessageId: input.clientMessageId.toLowerCase(),
    };
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) =>
            this.sendInTransaction(transaction, normalizedInput),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        const code = this.prismaErrorCode(error);

        if (code === 'P2002') {
          const winner = await this.readConcurrentWinner(normalizedInput);
          if (winner) return winner;
        }

        const retryable = code === 'P2034' || code === 'P2002';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async listForMember(
    conversationId: string,
    userId: string,
    cursor: MessagePageCursor | null,
    take: number,
  ): Promise<ListMessagesResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    return this.prisma.$transaction(
      async (transaction) => {
        const members = await transaction.conversationMember.findMany({
          where: { conversationId: normalizedConversationId },
          select: {
            userId: true,
            clearedAt: true,
            clearedThroughMessageId: true,
          },
        });
        const membership = members.find(
          (member) => member.userId === normalizedUserId,
        );
        if (!membership) {
          return { status: 'conversation-not-found' } as const;
        }

        const messages = await transaction.message.findMany({
          where: {
            conversationId: normalizedConversationId,
            AND: [
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
              ...(cursor
                ? [
                    {
                      OR: [
                        { createdAt: { lt: cursor.createdAt } },
                        {
                          createdAt: cursor.createdAt,
                          id: { lt: cursor.id },
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
          select: messageSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        });
        const participantIds = this.uniqueUserIds(members);

        return {
          status: 'found',
          messages: messages.map((message) =>
            this.mapMessage(message, participantIds),
          ),
        } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async markRead(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<MarkConversationReadResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();

    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const membership = await transaction.conversationMember.findUnique({
              where: {
                conversationId_userId: {
                  conversationId: normalizedConversationId,
                  userId: normalizedUserId,
                },
              },
              select: { conversationId: true, lastReadAt: true },
            });
            if (!membership) {
              return { status: 'conversation-not-found' } as const;
            }

            const latestMessage = await transaction.message.findFirst({
              where: { conversationId: normalizedConversationId },
              select: { createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });
            const readBoundary = this.latestDate(
              now,
              membership.lastReadAt,
              latestMessage?.createdAt,
            );
            const updated = await transaction.conversationMember.update({
              where: {
                conversationId_userId: {
                  conversationId: normalizedConversationId,
                  userId: normalizedUserId,
                },
              },
              data: { unreadCount: 0, lastReadAt: readBoundary },
              select: {
                conversationId: true,
                lastReadAt: true,
                unreadCount: true,
              },
            });
            if (!updated.lastReadAt) {
              throw new Error('Updated read state is missing its timestamp.');
            }

            return {
              status: 'updated',
              state: {
                conversationId: updated.conversationId,
                lastReadAt: updated.lastReadAt,
                unreadCount: updated.unreadCount,
              },
            } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        const retryable = this.prismaErrorCode(error) === 'P2034';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async clearForMember(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<ClearConversationMessagesResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const membership = await transaction.conversationMember.findUnique({
              where: {
                conversationId_userId: {
                  conversationId: normalizedConversationId,
                  userId: normalizedUserId,
                },
              },
              select: {
                clearedAt: true,
                clearedThroughMessageId: true,
                unreadCount: true,
              },
            });
            if (!membership) {
              return { status: 'conversation-not-found' } as const;
            }

            const latestMessage = await transaction.message.findFirst({
              where: { conversationId: normalizedConversationId },
              select: { id: true, createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });
            const boundaryAdvanced =
              latestMessage !== null &&
              this.isAfterBoundary(
                latestMessage.createdAt,
                latestMessage.id,
                membership.clearedAt,
                membership.clearedThroughMessageId,
              );
            const changed = boundaryAdvanced || membership.unreadCount !== 0;

            if (changed) {
              try {
                await transaction.conversationMember.update({
                  where: {
                    conversationId_userId: {
                      conversationId: normalizedConversationId,
                      userId: normalizedUserId,
                    },
                  },
                  data: {
                    unreadCount: 0,
                    ...(boundaryAdvanced && latestMessage
                      ? {
                          clearedAt: latestMessage.createdAt,
                          clearedThroughMessageId: latestMessage.id,
                        }
                      : {}),
                  },
                });
              } catch (error) {
                if (this.prismaErrorCode(error) === 'P2025') {
                  return { status: 'conversation-not-found' } as const;
                }
                throw error;
              }
            }

            const clearedAt = boundaryAdvanced
              ? (latestMessage?.createdAt ?? null)
              : membership.clearedAt;
            const clearedThroughMessageId = boundaryAdvanced
              ? (latestMessage?.id ?? null)
              : membership.clearedThroughMessageId;

            return {
              status: 'cleared',
              conversationId: normalizedConversationId,
              userId: normalizedUserId,
              changed,
              clearedAt,
              clearedThroughMessageId,
              occurredAt: now,
            } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        const retryable = this.prismaErrorCode(error) === 'P2034';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  private async sendInTransaction(
    transaction: Prisma.TransactionClient,
    input: SendTextMessageInput,
  ): Promise<SendTextMessageResult> {
    const conversation = await transaction.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        type: true,
        members: { select: { userId: true, clearedAt: true } },
      },
    });
    const members = conversation?.members ?? [];
    if (!members.some((member) => member.userId === input.senderId)) {
      return { status: 'conversation-not-found' };
    }
    const participantIds = this.uniqueUserIds(members);

    // Idempotency describes the already-committed request, so a later block
    // must not change a safe retry from success (or conflict) into a 404.
    const existing = await transaction.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
        },
      },
      select: messageSelect,
    });
    if (existing) {
      return this.resolveExisting(existing, input, participantIds);
    }

    if (
      conversation?.type === 'DIRECT' &&
      (await this.hasBlockBetweenDirectParticipants(
        transaction,
        input.senderId,
        members,
      ))
    ) {
      return { status: 'conversation-not-found' };
    }

    const newestClearTimestamp = members.reduce<Date | null>(
      (latest, member) =>
        member.clearedAt &&
        (!latest || member.clearedAt.getTime() > latest.getTime())
          ? member.clearedAt
          : latest,
      null,
    );
    const messageCreatedAt =
      newestClearTimestamp &&
      newestClearTimestamp.getTime() >= input.now.getTime()
        ? new Date(newestClearTimestamp.getTime() + 1)
        : input.now;

    const message = await transaction.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.senderId,
        clientMessageId: input.clientMessageId,
        kind: MessageKind.TEXT,
        text: input.text,
        createdAt: messageCreatedAt,
      },
      select: messageSelect,
    });
    await transaction.conversation.updateMany({
      where: {
        id: input.conversationId,
        lastActivityAt: { lt: messageCreatedAt },
      },
      data: {
        lastActivityAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
      },
    });
    await transaction.conversationMember.updateMany({
      where: {
        conversationId: input.conversationId,
        userId: { not: input.senderId },
      },
      data: { unreadCount: { increment: 1 } },
    });

    return {
      status: 'created',
      message: this.mapMessage(message, participantIds),
    };
  }

  private async readConcurrentWinner(
    input: SendTextMessageInput,
  ): Promise<SendTextMessageResult | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        type: true,
        members: { select: { userId: true } },
      },
    });
    const members = conversation?.members ?? [];
    if (!members.some((member) => member.userId === input.senderId)) {
      return { status: 'conversation-not-found' };
    }

    const winner = await this.prisma.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
        },
      },
      select: messageSelect,
    });
    if (winner) {
      return this.resolveExisting(winner, input, this.uniqueUserIds(members));
    }

    if (
      conversation?.type === 'DIRECT' &&
      (await this.hasBlockBetweenDirectParticipants(
        this.prisma,
        input.senderId,
        members,
      ))
    ) {
      return { status: 'conversation-not-found' };
    }
    return null;
  }

  private resolveExisting(
    message: SelectedMessage,
    input: SendTextMessageInput,
    participantIds: string[],
  ): SendTextMessageResult {
    if (
      message.conversationId !== input.conversationId ||
      message.kind !== MessageKind.TEXT ||
      message.text !== input.text
    ) {
      return { status: 'idempotency-conflict' };
    }
    return {
      status: 'existing',
      message: this.mapMessage(message, participantIds),
    };
  }

  private mapMessage(
    message: SelectedMessage,
    participantIds: string[],
  ): MessageRecord {
    return {
      id: message.id,
      conversationId: message.conversationId,
      clientMessageId: message.clientMessageId,
      senderId: message.senderId,
      kind: 'TEXT',
      text: message.text,
      createdAt: message.createdAt,
      participantIds,
    };
  }

  private uniqueUserIds(members: Array<{ userId: string }>): string[] {
    return [...new Set(members.map((member) => member.userId))];
  }

  private async hasBlockBetweenDirectParticipants(
    client: Pick<Prisma.TransactionClient, 'userBlock'>,
    senderId: string,
    members: Array<{ userId: string }>,
  ): Promise<boolean> {
    const otherUserId = members.find(
      (member) => member.userId !== senderId,
    )?.userId;
    if (!otherUserId) return true;

    const block = await client.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: senderId, blockedId: otherUserId },
          { blockerId: otherUserId, blockedId: senderId },
        ],
      },
      select: { blockerId: true },
    });
    return block !== null;
  }

  private latestDate(
    first: Date,
    ...candidates: Array<Date | null | undefined>
  ): Date {
    return candidates.reduce<Date>(
      (latest, candidate) =>
        candidate && candidate.getTime() > latest.getTime()
          ? candidate
          : latest,
      first,
    );
  }

  private isAfterBoundary(
    createdAt: Date,
    id: string,
    boundaryCreatedAt: Date | null,
    boundaryId: string | null,
  ): boolean {
    if (!boundaryCreatedAt || !boundaryId) return true;
    const timeDifference = createdAt.getTime() - boundaryCreatedAt.getTime();
    return timeDifference > 0 || (timeDifference === 0 && id > boundaryId);
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }
}

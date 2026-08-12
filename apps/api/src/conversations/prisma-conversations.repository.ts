import { Injectable } from '@nestjs/common';
import { ConversationType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ConversationsRepository } from './conversations.repository';
import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
} from './conversations.types';

const conversationWithMembers = {
  members: {
    include: {
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
  },
} satisfies Prisma.ConversationInclude;

type ConversationWithMembers = Prisma.ConversationGetPayload<{
  include: typeof conversationWithMembers;
}>;

type TransactionCreateResult =
  | {
      status: 'created' | 'existing';
      conversation: ConversationWithMembers;
    }
  | { status: 'participant-not-found' };

@Injectable()
export class PrismaConversationsRepository extends ConversationsRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async createOrGetDirect(
    userId: string,
    participantId: string,
    now: Date,
  ): Promise<CreateDirectConversationResult> {
    const normalizedUserId = userId.toLowerCase();
    const normalizedParticipantId = participantId.toLowerCase();
    const [directUserOneId, directUserTwoId] = this.canonicalPair(
      normalizedUserId,
      normalizedParticipantId,
    );
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const result = await this.prisma.$transaction(
          async (transaction) => {
            const existing = await transaction.conversation.findUnique({
              where: {
                directUserOneId_directUserTwoId: {
                  directUserOneId,
                  directUserTwoId,
                },
              },
              include: conversationWithMembers,
            });
            if (existing) {
              return { status: 'existing', conversation: existing } as const;
            }

            const participant = await transaction.user.findUnique({
              where: { id: normalizedParticipantId },
              select: { id: true },
            });
            if (!participant) {
              return { status: 'participant-not-found' } as const;
            }

            const conversation = await transaction.conversation.create({
              data: {
                type: ConversationType.DIRECT,
                directUserOneId,
                directUserTwoId,
                lastActivityAt: now,
                createdAt: now,
                updatedAt: now,
                members: {
                  create: [
                    { userId: normalizedUserId, joinedAt: now },
                    { userId: normalizedParticipantId, joinedAt: now },
                  ],
                },
              },
              include: conversationWithMembers,
            });
            return { status: 'created', conversation } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );

        return this.mapCreateResult(result, normalizedUserId);
      } catch (error) {
        lastError = error;
        const code = this.prismaErrorCode(error);
        if (code === 'P2002') {
          const winner = await this.findDirectByPair(
            directUserOneId,
            directUserTwoId,
          );
          if (winner) {
            return {
              status: 'existing',
              conversation: this.mapConversation(winner, normalizedUserId),
            };
          }
        }

        const retryable = code === 'P2034' || code === 'P2002';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
  ): Promise<ConversationRecord[]> {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        type: ConversationType.DIRECT,
        members: { some: { userId } },
        ...(cursor
          ? {
              OR: [
                { lastActivityAt: { lt: cursor.lastActivityAt } },
                {
                  lastActivityAt: cursor.lastActivityAt,
                  id: { lt: cursor.id },
                },
              ],
            }
          : {}),
      },
      include: conversationWithMembers,
      orderBy: [{ lastActivityAt: 'desc' }, { id: 'desc' }],
      take,
    });

    return conversations.map((conversation) =>
      this.mapConversation(conversation, userId),
    );
  }

  async findForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationRecord | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId,
        type: ConversationType.DIRECT,
        members: { some: { userId } },
      },
      include: conversationWithMembers,
    });
    return conversation ? this.mapConversation(conversation, userId) : null;
  }

  private findDirectByPair(
    directUserOneId: string,
    directUserTwoId: string,
  ): Promise<ConversationWithMembers | null> {
    return this.prisma.conversation.findUnique({
      where: {
        directUserOneId_directUserTwoId: {
          directUserOneId,
          directUserTwoId,
        },
      },
      include: conversationWithMembers,
    });
  }

  private mapCreateResult(
    result: TransactionCreateResult,
    userId: string,
  ): CreateDirectConversationResult {
    if (result.status === 'participant-not-found') return result;
    return {
      status: result.status,
      conversation: this.mapConversation(result.conversation, userId),
    };
  }

  private mapConversation(
    conversation: ConversationWithMembers,
    userId: string,
  ): ConversationRecord {
    const otherMember = conversation.members.find(
      (member) => member.userId !== userId,
    );
    if (!otherMember) {
      throw new Error('Direct conversation is missing its other participant.');
    }

    return {
      id: conversation.id,
      type: 'DIRECT',
      otherParticipant: {
        id: otherMember.user.id,
        displayName: otherMember.user.displayName,
        avatarUrl: otherMember.user.avatarUrl,
      },
      lastActivityAt: conversation.lastActivityAt,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };
  }

  private canonicalPair(
    userId: string,
    participantId: string,
  ): [string, string] {
    return userId < participantId
      ? [userId, participantId]
      : [participantId, userId];
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }
}

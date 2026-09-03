import { Injectable } from '@nestjs/common';
import {
  ConversationMemberRole,
  ConversationType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ConversationsRepository } from './conversations.repository';
import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
  CreateGroupConversationInput,
  CreateGroupConversationResult,
} from './conversations.types';

const conversationWithMembers = {
  members: {
    select: {
      userId: true,
      joinedAt: true,
      role: true,
      archivedAt: true,
      mutedAt: true,
      pinnedAt: true,
      unreadCount: true,
      user: {
        select: {
          id: true,
          displayName: true,
          avatarUrl: true,
        },
      },
    },
    orderBy: [{ joinedAt: 'asc' as const }, { userId: 'asc' as const }],
  },
  messages: {
    select: {
      id: true,
      senderId: true,
      kind: true,
      text: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
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
            if (
              await this.hasBlockBetween(
                transaction,
                normalizedUserId,
                normalizedParticipantId,
              )
            ) {
              return { status: 'participant-not-found' } as const;
            }
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
          if (
            await this.hasBlockBetween(
              this.prisma,
              normalizedUserId,
              normalizedParticipantId,
            )
          ) {
            return { status: 'participant-not-found' };
          }
          const winner = await this.findDirectByPair(
            directUserOneId,
            directUserTwoId,
          );
          if (winner) {
            return {
              status: 'existing',
              conversation: this.mapDirectConversation(
                winner,
                normalizedUserId,
              ),
            };
          }
        }

        const retryable = code === 'P2034' || code === 'P2002';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  override async createGroup(
    input: CreateGroupConversationInput,
  ): Promise<CreateGroupConversationResult> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const blockedParticipant = await transaction.userBlock.findFirst({
              where: {
                OR: [
                  {
                    blockerId: input.creatorId,
                    blockedId: { in: input.participantIds },
                  },
                  {
                    blockerId: { in: input.participantIds },
                    blockedId: input.creatorId,
                  },
                ],
              },
              select: { blockerId: true },
            });
            if (blockedParticipant) {
              return { status: 'participant-not-found' } as const;
            }

            const participants = await transaction.user.findMany({
              where: { id: { in: input.participantIds } },
              select: { id: true },
            });
            if (participants.length !== input.participantIds.length) {
              return { status: 'participant-not-found' } as const;
            }

            const conversation = await transaction.conversation.create({
              data: {
                type: ConversationType.GROUP,
                name: input.name,
                avatarUrl: input.avatarUrl,
                createdById: input.creatorId,
                lastActivityAt: input.now,
                createdAt: input.now,
                updatedAt: input.now,
                members: {
                  create: [
                    {
                      userId: input.creatorId,
                      joinedAt: input.now,
                      role: ConversationMemberRole.OWNER,
                    },
                    ...input.participantIds.map((participantId) => ({
                      userId: participantId,
                      joinedAt: input.now,
                      role: ConversationMemberRole.MEMBER,
                    })),
                  ],
                },
              },
              include: conversationWithMembers,
            });

            const mappedConversation = this.mapConversation(
              conversation,
              input.creatorId,
            );
            if (mappedConversation.type !== 'GROUP') {
              throw new Error(
                'Created group has an invalid conversation type.',
              );
            }
            return {
              status: 'created',
              conversation: mappedConversation,
            } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        const code = this.prismaErrorCode(error);
        if (code === 'P2003') return { status: 'participant-not-found' };
        if (code !== 'P2034' || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
    archived = false,
  ): Promise<ConversationRecord[]> {
    const normalizedUserId = userId.toLowerCase();
    if (!cursor || cursor.pinned) {
      const pinnedConversations = await this.listSegment(
        normalizedUserId,
        cursor,
        take,
        archived,
        true,
      );
      if (pinnedConversations.length === take) {
        return pinnedConversations.map((conversation) =>
          this.mapConversation(conversation, normalizedUserId),
        );
      }

      const unpinnedConversations = await this.listSegment(
        normalizedUserId,
        null,
        take - pinnedConversations.length,
        archived,
        false,
      );
      return [...pinnedConversations, ...unpinnedConversations].map(
        (conversation) => this.mapConversation(conversation, normalizedUserId),
      );
    }

    const conversations = await this.listSegment(
      normalizedUserId,
      cursor,
      take,
      archived,
      false,
    );
    return conversations.map((conversation) =>
      this.mapConversation(conversation, normalizedUserId),
    );
  }

  private listSegment(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
    archived: boolean,
    pinned: boolean,
  ): Promise<ConversationWithMembers[]> {
    return this.prisma.conversation.findMany({
      where: {
        members: {
          some: {
            userId,
            archivedAt: archived ? { not: null } : null,
            pinnedAt: pinned ? { not: null } : null,
          },
        },
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
  }

  async findForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationRecord | null> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: normalizedConversationId,
        members: { some: { userId: normalizedUserId } },
      },
      include: conversationWithMembers,
    });
    return conversation
      ? this.mapConversation(conversation, normalizedUserId)
      : null;
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
      conversation: this.mapDirectConversation(result.conversation, userId),
    };
  }

  private mapDirectConversation(
    conversation: ConversationWithMembers,
    userId: string,
  ) {
    const mapped = this.mapConversation(conversation, userId);
    if (mapped.type !== 'DIRECT') {
      throw new Error('Direct conversation lookup returned a group.');
    }
    return mapped;
  }

  private mapConversation(
    conversation: ConversationWithMembers,
    userId: string,
  ): ConversationRecord {
    const actorMember = conversation.members.find(
      (member) => member.userId === userId,
    );
    const otherMember = conversation.members.find(
      (member) => member.userId !== userId,
    );
    if (!actorMember) {
      throw new Error('Conversation is missing the actor membership.');
    }
    const latestMessage = conversation.messages[0] ?? null;
    const common = {
      id: conversation.id,
      settings: {
        archivedAt: actorMember.archivedAt,
        mutedAt: actorMember.mutedAt,
        pinnedAt: actorMember.pinnedAt,
      },
      latestMessage: latestMessage
        ? {
            id: latestMessage.id,
            senderId: latestMessage.senderId,
            kind: latestMessage.kind,
            text: latestMessage.text,
            createdAt: latestMessage.createdAt,
          }
        : null,
      unreadCount: actorMember.unreadCount,
      lastActivityAt: conversation.lastActivityAt,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
    };

    if (conversation.type === ConversationType.DIRECT) {
      if (!otherMember) {
        throw new Error(
          'Direct conversation is missing its other participant.',
        );
      }
      return {
        ...common,
        type: 'DIRECT',
        otherParticipant: {
          id: otherMember.user.id,
          displayName: otherMember.user.displayName,
          avatarUrl: otherMember.user.avatarUrl,
        },
      };
    }

    if (!conversation.name) {
      throw new Error('Group conversation is missing its name.');
    }
    return {
      ...common,
      type: 'GROUP',
      name: conversation.name,
      avatarUrl: conversation.avatarUrl,
      participants: conversation.members.map((member) => ({
        id: member.user.id,
        displayName: member.user.displayName,
        avatarUrl: member.user.avatarUrl,
        role: member.role,
      })),
      role: actorMember.role,
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

  private async hasBlockBetween(
    client: Pick<Prisma.TransactionClient, 'userBlock'>,
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    const block = await client.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: firstUserId, blockedId: secondUserId },
          { blockerId: secondUserId, blockedId: firstUserId },
        ],
      },
      select: { blockerId: true },
    });
    return block !== null;
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }
}

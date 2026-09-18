import { Injectable } from '@nestjs/common';
import {
  ConversationMemberRole,
  ConversationType,
  MediaPurpose,
  MediaStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { ConversationsRepository } from './conversations.repository';
import type {
  AddGroupMembersInput,
  AddGroupMembersResult,
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
  CreateGroupConversationInput,
  CreateGroupConversationResult,
  DeleteGroupInput,
  DeleteGroupResult,
  DeleteDirectChatResult,
  GroupConversationRecord,
  LeaveGroupInput,
  LeaveGroupResult,
  RemoveGroupMemberInput,
  RemoveGroupMemberResult,
  TransferGroupOwnershipInput,
  TransferGroupOwnershipResult,
  UpdateGroupInput,
  UpdateGroupMemberRoleInput,
  UpdateGroupMemberRoleResult,
  UpdateGroupResult,
} from './conversations.types';

const MAX_GROUP_MEMBERS = 100;

const conversationWithMembers = {
  members: {
    select: {
      userId: true,
      joinedAt: true,
      role: true,
      archivedAt: true,
      mutedAt: true,
      mutedUntil: true,
      pinnedAt: true,
      favoritedAt: true,
      deletedAt: true,
      clearedAt: true,
      clearedThroughMessageId: true,
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
      deletedAt: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
  },
} satisfies Prisma.ConversationInclude;

type ConversationWithMembers = Prisma.ConversationGetPayload<{
  include: typeof conversationWithMembers;
}>;

type ConversationMemberWithUser = ConversationWithMembers['members'][number];

type TransactionCreateResult =
  | {
      status: 'created' | 'existing';
      conversation: ConversationWithMembers;
    }
  | { status: 'participant-not-found' };

class GroupMutationRaceError extends Error {
  constructor(readonly status: 'forbidden' | 'member-not-found') {
    super(`Group mutation lost a concurrent race: ${status}`);
  }
}

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

            const avatar = input.avatarMediaId
              ? await this.findReadyGroupAvatar(
                  transaction,
                  input.creatorId,
                  input.avatarMediaId,
                )
              : null;
            if (input.avatarMediaId && !avatar) {
              return { status: 'avatar-unavailable' } as const;
            }

            const conversation = await transaction.conversation.create({
              data: {
                type: ConversationType.GROUP,
                name: input.name,
                avatarMediaId: avatar?.id ?? null,
                avatarUrl: avatar?.secureUrl ?? null,
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

  override async updateGroup(
    input: UpdateGroupInput,
  ): Promise<UpdateGroupResult> {
    const normalizedInput = this.normalizeGroupMutationInput(input);

    try {
      return await this.runSerializable(async (transaction) => {
        const conversation = await this.findConversationForMutation(
          transaction,
          normalizedInput.conversationId,
        );
        const actor = this.findGroupActor(
          conversation,
          normalizedInput.actorId,
        );
        if (!conversation || !actor) {
          return { status: 'conversation-not-found' } as const;
        }
        if (!this.canManageGroup(actor)) {
          return { status: 'forbidden' } as const;
        }

        // Authorize membership/role before looking up media, and resolve both
        // in this serializable transaction so failed assignment is atomic.
        const avatar = normalizedInput.avatarMediaId
          ? await this.findReadyGroupAvatar(
              transaction,
              normalizedInput.actorId,
              normalizedInput.avatarMediaId,
            )
          : null;
        if (normalizedInput.avatarMediaId && !avatar) {
          return { status: 'avatar-unavailable' } as const;
        }
        const nameChanged =
          normalizedInput.name !== undefined &&
          normalizedInput.name !== conversation.name;
        const avatarChanged =
          normalizedInput.avatarMediaId !== undefined &&
          ((avatar?.id ?? null) !== conversation.avatarMediaId ||
            (avatar?.secureUrl ?? null) !== conversation.avatarUrl);
        const changed = nameChanged || avatarChanged;
        const eventRecipientIds = this.memberIds(conversation);
        if (!changed) {
          return {
            status: 'updated',
            changed: false,
            conversation: this.mapGroupConversation(
              conversation,
              normalizedInput.actorId,
            ),
            eventRecipientIds,
          } as const;
        }

        const updated = await transaction.conversation.update({
          where: { id: normalizedInput.conversationId },
          data: {
            ...(nameChanged ? { name: normalizedInput.name } : {}),
            ...(avatarChanged
              ? {
                  avatarMediaId: avatar?.id ?? null,
                  avatarUrl: avatar?.secureUrl ?? null,
                }
              : {}),
            updatedAt: normalizedInput.now,
          },
          include: conversationWithMembers,
        });
        return {
          status: 'updated',
          changed: true,
          conversation: this.mapGroupConversation(
            updated,
            normalizedInput.actorId,
          ),
          eventRecipientIds: this.memberIds(updated),
        } as const;
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2025') {
        return { status: 'conversation-not-found' };
      }
      throw error;
    }
  }

  override async addGroupMembers(
    input: AddGroupMembersInput,
  ): Promise<AddGroupMembersResult> {
    const normalizedInput = {
      ...this.normalizeGroupMutationInput(input),
      participantIds: input.participantIds.map((participantId) =>
        participantId.toLowerCase(),
      ),
    };
    if (
      new Set(normalizedInput.participantIds).size !==
      normalizedInput.participantIds.length
    ) {
      return { status: 'member-already-exists' };
    }

    try {
      return await this.runSerializable(async (transaction) => {
        const conversation = await this.findConversationForMutation(
          transaction,
          normalizedInput.conversationId,
        );
        const actor = this.findGroupActor(
          conversation,
          normalizedInput.actorId,
        );
        if (!conversation || !actor) {
          return { status: 'conversation-not-found' } as const;
        }
        if (!this.canManageGroup(actor)) {
          return { status: 'forbidden' } as const;
        }

        const existingMemberIds = new Set(this.memberIds(conversation));
        if (
          normalizedInput.participantIds.some((participantId) =>
            existingMemberIds.has(participantId),
          )
        ) {
          return { status: 'member-already-exists' } as const;
        }
        if (
          conversation.members.length + normalizedInput.participantIds.length >
          MAX_GROUP_MEMBERS
        ) {
          return { status: 'group-full' } as const;
        }

        const blockedParticipant = await transaction.userBlock.findFirst({
          where: {
            OR: [
              {
                blockerId: normalizedInput.actorId,
                blockedId: { in: normalizedInput.participantIds },
              },
              {
                blockerId: { in: normalizedInput.participantIds },
                blockedId: normalizedInput.actorId,
              },
            ],
          },
          select: { blockerId: true },
        });
        if (blockedParticipant) {
          return { status: 'participant-not-found' } as const;
        }

        const participants = await transaction.user.findMany({
          where: { id: { in: normalizedInput.participantIds } },
          select: { id: true },
        });
        if (participants.length !== normalizedInput.participantIds.length) {
          return { status: 'participant-not-found' } as const;
        }

        const updated = await transaction.conversation.update({
          where: { id: normalizedInput.conversationId },
          data: {
            updatedAt: normalizedInput.now,
            members: {
              create: normalizedInput.participantIds.map((participantId) => ({
                userId: participantId,
                joinedAt: normalizedInput.now,
                role: ConversationMemberRole.MEMBER,
              })),
            },
          },
          include: conversationWithMembers,
        });
        return {
          status: 'members-added',
          conversation: this.mapGroupConversation(
            updated,
            normalizedInput.actorId,
          ),
          eventRecipientIds: this.memberIds(updated),
        } as const;
      });
    } catch (error) {
      const code = this.prismaErrorCode(error);
      if (code === 'P2002') return { status: 'member-already-exists' };
      if (code === 'P2003') return { status: 'participant-not-found' };
      if (code === 'P2025') return { status: 'conversation-not-found' };
      throw error;
    }
  }

  override async removeGroupMember(
    input: RemoveGroupMemberInput,
  ): Promise<RemoveGroupMemberResult> {
    const normalizedInput = {
      ...this.normalizeGroupMutationInput(input),
      memberId: input.memberId.toLowerCase(),
    };

    try {
      return await this.runSerializable(async (transaction) => {
        const conversation = await this.findConversationForMutation(
          transaction,
          normalizedInput.conversationId,
        );
        const actor = this.findGroupActor(
          conversation,
          normalizedInput.actorId,
        );
        if (!conversation || !actor) {
          return { status: 'conversation-not-found' } as const;
        }
        if (!this.canManageGroup(actor)) {
          return { status: 'forbidden' } as const;
        }

        const target = this.findMember(conversation, normalizedInput.memberId);
        if (!target) return { status: 'member-not-found' } as const;
        if (target.role === ConversationMemberRole.OWNER) {
          return { status: 'owner-protected' } as const;
        }
        if (
          actor.role === ConversationMemberRole.ADMIN &&
          target.role !== ConversationMemberRole.MEMBER
        ) {
          return { status: 'forbidden' } as const;
        }

        const eventRecipientIds = this.memberIds(conversation);
        const removed = await transaction.conversationMember.deleteMany({
          where: {
            conversationId: normalizedInput.conversationId,
            userId: normalizedInput.memberId,
          },
        });
        if (removed.count === 0) {
          return { status: 'member-not-found' } as const;
        }
        const updated = await transaction.conversation.update({
          where: { id: normalizedInput.conversationId },
          data: { updatedAt: normalizedInput.now },
          include: conversationWithMembers,
        });
        return {
          status: 'member-removed',
          conversation: this.mapGroupConversation(
            updated,
            normalizedInput.actorId,
          ),
          eventRecipientIds,
        } as const;
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2025') {
        return { status: 'conversation-not-found' };
      }
      throw error;
    }
  }

  override async updateGroupMemberRole(
    input: UpdateGroupMemberRoleInput,
  ): Promise<UpdateGroupMemberRoleResult> {
    const normalizedInput = {
      ...this.normalizeGroupMutationInput(input),
      memberId: input.memberId.toLowerCase(),
    };

    try {
      return await this.runSerializable(async (transaction) => {
        const conversation = await this.findConversationForMutation(
          transaction,
          normalizedInput.conversationId,
        );
        const actor = this.findGroupActor(
          conversation,
          normalizedInput.actorId,
        );
        if (!conversation || !actor) {
          return { status: 'conversation-not-found' } as const;
        }
        if (actor.role !== ConversationMemberRole.OWNER) {
          return { status: 'forbidden' } as const;
        }

        const target = this.findMember(conversation, normalizedInput.memberId);
        if (!target) return { status: 'member-not-found' } as const;
        if (target.role === ConversationMemberRole.OWNER) {
          return { status: 'owner-protected' } as const;
        }

        const eventRecipientIds = this.memberIds(conversation);
        if (target.role === normalizedInput.role) {
          return {
            status: 'role-updated',
            changed: false,
            conversation: this.mapGroupConversation(
              conversation,
              normalizedInput.actorId,
            ),
            eventRecipientIds,
          } as const;
        }

        const changed = await transaction.conversationMember.updateMany({
          where: {
            conversationId: normalizedInput.conversationId,
            userId: normalizedInput.memberId,
            role: target.role,
          },
          data: { role: normalizedInput.role },
        });
        if (changed.count === 0) {
          return { status: 'member-not-found' } as const;
        }
        const updated = await transaction.conversation.update({
          where: { id: normalizedInput.conversationId },
          data: { updatedAt: normalizedInput.now },
          include: conversationWithMembers,
        });
        return {
          status: 'role-updated',
          changed: true,
          conversation: this.mapGroupConversation(
            updated,
            normalizedInput.actorId,
          ),
          eventRecipientIds: this.memberIds(updated),
        } as const;
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2025') {
        return { status: 'conversation-not-found' };
      }
      throw error;
    }
  }

  override async transferGroupOwnership(
    input: TransferGroupOwnershipInput,
  ): Promise<TransferGroupOwnershipResult> {
    const normalizedInput = {
      ...this.normalizeGroupMutationInput(input),
      memberId: input.memberId.toLowerCase(),
    };

    try {
      return await this.runSerializable(async (transaction) => {
        const conversation = await this.findConversationForMutation(
          transaction,
          normalizedInput.conversationId,
        );
        const actor = this.findGroupActor(
          conversation,
          normalizedInput.actorId,
        );
        if (!conversation || !actor) {
          return { status: 'conversation-not-found' } as const;
        }
        if (actor.role !== ConversationMemberRole.OWNER) {
          return { status: 'forbidden' } as const;
        }

        const target = this.findMember(conversation, normalizedInput.memberId);
        if (!target) return { status: 'member-not-found' } as const;
        const eventRecipientIds = this.memberIds(conversation);
        if (target.userId === normalizedInput.actorId) {
          return {
            status: 'ownership-transferred',
            changed: false,
            conversation: this.mapGroupConversation(
              conversation,
              normalizedInput.actorId,
            ),
            eventRecipientIds,
          } as const;
        }

        const demoted = await transaction.conversationMember.updateMany({
          where: {
            conversationId: normalizedInput.conversationId,
            userId: normalizedInput.actorId,
            role: ConversationMemberRole.OWNER,
          },
          data: { role: ConversationMemberRole.ADMIN },
        });
        if (demoted.count !== 1) {
          throw new GroupMutationRaceError('forbidden');
        }
        const promoted = await transaction.conversationMember.updateMany({
          where: {
            conversationId: normalizedInput.conversationId,
            userId: normalizedInput.memberId,
            role: target.role,
          },
          data: { role: ConversationMemberRole.OWNER },
        });
        if (promoted.count !== 1) {
          throw new GroupMutationRaceError('member-not-found');
        }

        const updated = await transaction.conversation.update({
          where: { id: normalizedInput.conversationId },
          data: { updatedAt: normalizedInput.now },
          include: conversationWithMembers,
        });
        return {
          status: 'ownership-transferred',
          changed: true,
          conversation: this.mapGroupConversation(
            updated,
            normalizedInput.actorId,
          ),
          eventRecipientIds: this.memberIds(updated),
        } as const;
      });
    } catch (error) {
      if (error instanceof GroupMutationRaceError) {
        return { status: error.status };
      }
      if (this.prismaErrorCode(error) === 'P2025') {
        return { status: 'conversation-not-found' };
      }
      throw error;
    }
  }

  override async leaveGroup(input: LeaveGroupInput): Promise<LeaveGroupResult> {
    const normalizedInput = this.normalizeGroupMutationInput(input);

    try {
      return await this.runSerializable(async (transaction) => {
        const conversation = await this.findConversationForMutation(
          transaction,
          normalizedInput.conversationId,
        );
        const actor = this.findGroupActor(
          conversation,
          normalizedInput.actorId,
        );
        if (!conversation || !actor) {
          return { status: 'conversation-not-found' } as const;
        }
        if (actor.role === ConversationMemberRole.OWNER) {
          return { status: 'owner-transfer-required' } as const;
        }

        const eventRecipientIds = this.memberIds(conversation);
        const removed = await transaction.conversationMember.deleteMany({
          where: {
            conversationId: normalizedInput.conversationId,
            userId: normalizedInput.actorId,
          },
        });
        if (removed.count !== 1) {
          return { status: 'conversation-not-found' } as const;
        }
        await transaction.conversation.update({
          where: { id: normalizedInput.conversationId },
          data: { updatedAt: normalizedInput.now },
          select: { id: true },
        });
        return { status: 'left', eventRecipientIds } as const;
      });
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2025') {
        return { status: 'conversation-not-found' };
      }
      throw error;
    }
  }

  override async deleteGroup(
    input: DeleteGroupInput,
  ): Promise<DeleteGroupResult> {
    const normalizedInput = this.normalizeGroupMutationInput(input);

    return this.runSerializable(async (transaction) => {
      const conversation = await this.findConversationForMutation(
        transaction,
        normalizedInput.conversationId,
      );
      const actor = this.findGroupActor(conversation, normalizedInput.actorId);
      if (!conversation || !actor) {
        return { status: 'conversation-not-found' } as const;
      }
      if (actor.role !== ConversationMemberRole.OWNER) {
        return { status: 'forbidden' } as const;
      }

      const eventRecipientIds = this.memberIds(conversation);
      const deleted = await transaction.conversation.deleteMany({
        where: {
          id: normalizedInput.conversationId,
          type: ConversationType.GROUP,
        },
      });
      if (deleted.count !== 1) {
        return { status: 'conversation-not-found' } as const;
      }
      return { status: 'deleted', eventRecipientIds } as const;
    });
  }

  async deleteDirectForMember(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<DeleteDirectChatResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    return this.runSerializable(async (transaction) => {
      const where = {
        conversationId_userId: {
          conversationId: normalizedConversationId,
          userId: normalizedUserId,
        },
      };
      const member = await transaction.conversationMember.findUnique({
        where,
        select: {
          deletedAt: true,
          clearedAt: true,
          clearedThroughMessageId: true,
          conversation: { select: { type: true } },
        },
      });
      if (!member) return { status: 'conversation-not-found' };
      if (member.conversation.type !== ConversationType.DIRECT) {
        return { status: 'not-direct' };
      }
      const common = {
        status: 'deleted' as const,
        conversationId: normalizedConversationId,
        userId: normalizedUserId,
        occurredAt: now,
      };
      if (member.deletedAt) {
        return {
          ...common,
          changed: false,
          deletedAt: member.deletedAt,
          clearedAt: member.clearedAt,
          clearedThroughMessageId: member.clearedThroughMessageId,
        };
      }

      const latest = await transaction.message.findFirst({
        where: { conversationId: normalizedConversationId },
        select: { id: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      });
      const advancesBoundary =
        latest &&
        (!member.clearedAt ||
          !member.clearedThroughMessageId ||
          latest.createdAt > member.clearedAt ||
          (latest.createdAt.getTime() === member.clearedAt.getTime() &&
            latest.id > member.clearedThroughMessageId));
      const clearedAt = advancesBoundary ? latest.createdAt : member.clearedAt;
      const clearedThroughMessageId = advancesBoundary
        ? latest.id
        : member.clearedThroughMessageId;
      // This transaction conflicts with message sends on the same memberships.
      // A retry observes either the new message or the completed deletion.
      await transaction.conversationMember.update({
        where,
        data: {
          deletedAt: now,
          clearedAt,
          clearedThroughMessageId,
          unreadCount: 0,
          archivedAt: null,
          pinnedAt: null,
          favoritedAt: null,
        },
      });
      return {
        ...common,
        changed: true,
        deletedAt: now,
        clearedAt,
        clearedThroughMessageId,
      };
    });
  }

  async listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
    archived = false,
    favoritedOnly = false,
  ): Promise<ConversationRecord[]> {
    const normalizedUserId = userId.toLowerCase();
    if (!cursor || cursor.pinned) {
      const pinnedConversations = await this.listSegment(
        normalizedUserId,
        cursor,
        take,
        archived,
        true,
        favoritedOnly,
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
        favoritedOnly,
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
      favoritedOnly,
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
    favoritedOnly: boolean,
  ): Promise<ConversationWithMembers[]> {
    return this.prisma.conversation.findMany({
      where: {
        members: {
          some: {
            userId,
            deletedAt: null,
            archivedAt: archived ? { not: null } : null,
            pinnedAt: pinned ? { not: null } : null,
            ...(favoritedOnly ? { favoritedAt: { not: null } } : {}),
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

  private mapGroupConversation(
    conversation: ConversationWithMembers,
    userId: string,
  ): GroupConversationRecord {
    const mapped = this.mapConversation(conversation, userId);
    if (mapped.type !== 'GROUP') {
      throw new Error('Group conversation lookup returned a direct chat.');
    }
    return mapped;
  }

  private findConversationForMutation(
    transaction: Prisma.TransactionClient,
    conversationId: string,
  ): Promise<ConversationWithMembers | null> {
    return transaction.conversation.findUnique({
      where: { id: conversationId },
      include: conversationWithMembers,
    });
  }

  private findGroupActor(
    conversation: ConversationWithMembers | null,
    actorId: string,
  ): ConversationMemberWithUser | null {
    if (!conversation || conversation.type !== ConversationType.GROUP) {
      return null;
    }
    return this.findMember(conversation, actorId);
  }

  private findMember(
    conversation: ConversationWithMembers,
    userId: string,
  ): ConversationMemberWithUser | null {
    return (
      conversation.members.find((member) => member.userId === userId) ?? null
    );
  }

  private canManageGroup(member: ConversationMemberWithUser): boolean {
    return (
      member.role === ConversationMemberRole.OWNER ||
      member.role === ConversationMemberRole.ADMIN
    );
  }

  private memberIds(conversation: ConversationWithMembers): string[] {
    return conversation.members.map((member) => member.userId);
  }

  private normalizeGroupMutationInput<
    T extends { conversationId: string; actorId: string; now: Date },
  >(input: T): T {
    return {
      ...input,
      conversationId: input.conversationId.toLowerCase(),
      actorId: input.actorId.toLowerCase(),
    };
  }

  private async findReadyGroupAvatar(
    transaction: Prisma.TransactionClient,
    ownerId: string,
    mediaId: string,
  ): Promise<{ id: string; secureUrl: string } | null> {
    const asset = await transaction.mediaAsset.findFirst({
      where: {
        id: mediaId.toLowerCase(),
        ownerId: ownerId.toLowerCase(),
        purpose: MediaPurpose.GROUP_AVATAR,
        status: MediaStatus.READY,
        resourceType: 'image',
        deliveryType: 'upload',
        completedAt: { not: null },
        deletedAt: null,
        byteSize: { gt: 0 },
        width: { gt: 0 },
        height: { gt: 0 },
        OR: [
          { format: { in: ['jpg', 'jpeg'] }, mimeType: 'image/jpeg' },
          { format: 'png', mimeType: 'image/png' },
          { format: 'webp', mimeType: 'image/webp' },
        ],
      },
      select: { id: true, secureUrl: true },
    });
    if (!asset?.secureUrl) return null;
    try {
      if (new URL(asset.secureUrl).protocol !== 'https:') return null;
    } catch {
      return null;
    }
    const claimed = await transaction.mediaAsset.updateMany({
      where: { id: asset.id, status: MediaStatus.READY },
      data: { unusedSince: null },
    });
    if (claimed.count !== 1) return null;
    return { id: asset.id, secureUrl: asset.secureUrl };
  }

  private async runSerializable<T>(
    operation: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error) {
        lastError = error;
        const retryable = this.prismaErrorCode(error) === 'P2034';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
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
        deletedAt: actorMember.deletedAt,
        archivedAt: actorMember.archivedAt,
        mutedAt: actorMember.mutedAt,
        mutedUntil: actorMember.mutedUntil,
        pinnedAt: actorMember.pinnedAt,
        favoritedAt: actorMember.favoritedAt,
        clearedAt: actorMember.clearedAt,
        clearedThroughMessageId: actorMember.clearedThroughMessageId,
      },
      latestMessage: latestMessage
        ? {
            id: latestMessage.id,
            senderId: latestMessage.senderId,
            kind: latestMessage.kind,
            text: latestMessage.text,
            deletedAt: latestMessage.deletedAt,
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

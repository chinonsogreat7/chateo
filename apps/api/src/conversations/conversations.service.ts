import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationEventsPublisher } from './conversation-events.publisher';
import { ConversationsRepository } from './conversations.repository';
import type {
  ConversationListResponseDto,
  ConversationResponseDto,
  DirectConversationResponseDto,
  GroupConversationResponseDto,
} from './dto/conversation-response.dto';
import type { CreateGroupConversationDto } from './dto/create-group-conversation.dto';
import type { AddGroupMembersDto } from './dto/add-group-members.dto';
import type { TransferGroupOwnershipDto } from './dto/transfer-group-ownership.dto';
import type { UpdateGroupConversationDto } from './dto/update-group-conversation.dto';
import type { UpdateGroupMemberRoleDto } from './dto/update-group-member-role.dto';
import type {
  ConversationLatestMessageRecord,
  ConversationPageCursor,
  ConversationRecord,
  DirectConversationRecord,
  GroupConversationRecord,
} from './conversations.types';

interface SerializedCursor {
  v: 2;
  pinned: boolean;
  archived: boolean;
  lastActivityAt: string;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 512;
const MAX_MESSAGE_PREVIEW_CODE_POINTS = 120;

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly repository: ConversationsRepository,
    private readonly clock: Clock,
    private readonly eventsPublisher: ConversationEventsPublisher,
  ) {}

  async createDirect(
    userId: string,
    participantId: string,
  ): Promise<DirectConversationResponseDto> {
    const normalizedUserId = userId.toLowerCase();
    const normalizedParticipantId = participantId.toLowerCase();

    if (normalizedUserId === normalizedParticipantId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_SELF_NOT_ALLOWED',
        'You cannot start a direct conversation with yourself.',
      );
    }

    const result = await this.repository.createOrGetDirect(
      normalizedUserId,
      normalizedParticipantId,
      this.clock.now(),
    );
    if (result.status === 'participant-not-found') {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'The selected user does not exist.',
      );
    }
    if (result.conversation.type !== 'DIRECT') {
      throw new Error('Direct conversation lookup returned a group.');
    }

    if (result.status === 'created') {
      this.publishCreatedBestEffort({
        conversationId: result.conversation.id,
        type: 'DIRECT',
        participantIds: [normalizedUserId, normalizedParticipantId],
        occurredAt: result.conversation.createdAt,
      });
    }

    return this.toResponse(result.conversation);
  }

  async createGroup(
    creatorId: string,
    input: CreateGroupConversationDto,
  ): Promise<GroupConversationResponseDto> {
    const normalizedCreatorId = creatorId.toLowerCase();
    const participantIds = input.participantIds.map((participantId) =>
      participantId.toLowerCase(),
    );
    const uniqueParticipantIds = new Set(participantIds);

    if (
      uniqueParticipantIds.size !== participantIds.length ||
      uniqueParticipantIds.has(normalizedCreatorId)
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_GROUP_PARTICIPANTS_INVALID',
        'Group participants must be unique and must not include the creator.',
      );
    }

    const result = await this.repository.createGroup({
      creatorId: normalizedCreatorId,
      name: input.name.trim(),
      avatarUrl: input.avatarUrl ?? null,
      participantIds,
      now: this.clock.now(),
    });
    if (result.status === 'participant-not-found') {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'One or more selected users do not exist.',
      );
    }

    this.publishCreatedBestEffort({
      conversationId: result.conversation.id,
      type: 'GROUP',
      participantIds: result.conversation.participants.map(
        (participant) => participant.id,
      ),
      occurredAt: result.conversation.createdAt,
    });

    return this.toResponse(result.conversation);
  }

  async updateGroup(
    actorId: string,
    conversationId: string,
    input: UpdateGroupConversationDto,
  ): Promise<GroupConversationResponseDto> {
    if (input.name === undefined && input.avatarUrl === undefined) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_GROUP_UPDATE_EMPTY',
        'At least one group property must be supplied.',
      );
    }

    const normalizedActorId = actorId.toLowerCase();
    const now = this.clock.now();
    const result = await this.repository.updateGroup({
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      ...(input.name === undefined ? {} : { name: input.name.trim() }),
      ...(input.avatarUrl === undefined ? {} : { avatarUrl: input.avatarUrl }),
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'forbidden') {
      throw this.groupForbiddenException();
    }
    if (result.status !== 'updated') {
      throw new Error(`Unexpected group update status: ${result.status}`);
    }

    if (result.changed) {
      this.publishGroupChangedBestEffort({
        kind: 'metadata-updated',
        conversationId: result.conversation.id,
        actorId: normalizedActorId,
        recipientIds: result.eventRecipientIds,
        name: result.conversation.name,
        avatarUrl: result.conversation.avatarUrl,
        occurredAt: now,
      });
    }
    return this.toResponse(result.conversation);
  }

  async addGroupMembers(
    actorId: string,
    conversationId: string,
    input: AddGroupMembersDto,
  ): Promise<GroupConversationResponseDto> {
    const normalizedActorId = actorId.toLowerCase();
    const participantIds = input.participantIds.map((participantId) =>
      participantId.toLowerCase(),
    );
    const uniqueParticipantIds = new Set(participantIds);
    if (
      participantIds.length === 0 ||
      participantIds.length > 99 ||
      uniqueParticipantIds.size !== participantIds.length ||
      uniqueParticipantIds.has(normalizedActorId)
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_GROUP_PARTICIPANTS_INVALID',
        'Group participants must be unique and must not include the acting user.',
      );
    }

    const now = this.clock.now();
    const result = await this.repository.addGroupMembers({
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      participantIds,
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'forbidden') {
      throw this.groupForbiddenException();
    }
    if (result.status === 'participant-not-found') {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'One or more selected users do not exist.',
      );
    }
    if (result.status === 'member-already-exists') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONVERSATION_MEMBER_ALREADY_EXISTS',
        'One or more selected users are already group members.',
      );
    }
    if (result.status === 'group-full') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONVERSATION_GROUP_FULL',
        'A group cannot contain more than 100 members.',
      );
    }
    if (result.status !== 'members-added') {
      throw new Error(`Unexpected add-members status: ${result.status}`);
    }

    this.publishGroupChangedBestEffort({
      kind: 'members-added',
      conversationId: result.conversation.id,
      actorId: normalizedActorId,
      recipientIds: result.eventRecipientIds,
      memberIds: participantIds,
      occurredAt: now,
    });
    return this.toResponse(result.conversation);
  }

  async removeGroupMember(
    actorId: string,
    conversationId: string,
    memberId: string,
  ): Promise<void> {
    const normalizedActorId = actorId.toLowerCase();
    const normalizedMemberId = memberId.toLowerCase();
    if (normalizedActorId === normalizedMemberId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_MEMBER_SELF_REMOVE_NOT_ALLOWED',
        'Use the leave endpoint to remove yourself from a group.',
      );
    }

    const now = this.clock.now();
    const result = await this.repository.removeGroupMember({
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      memberId: normalizedMemberId,
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'forbidden') {
      throw this.groupForbiddenException();
    }
    if (result.status === 'member-not-found') {
      throw this.memberNotFoundException();
    }
    if (result.status === 'owner-protected') {
      throw this.ownerProtectedException();
    }
    if (result.status !== 'member-removed') {
      throw new Error(`Unexpected remove-member status: ${result.status}`);
    }

    this.publishGroupChangedBestEffort({
      kind: 'member-removed',
      conversationId: result.conversation.id,
      actorId: normalizedActorId,
      recipientIds: result.eventRecipientIds,
      memberId: normalizedMemberId,
      reason: 'removed',
      occurredAt: now,
    });
  }

  async updateGroupMemberRole(
    actorId: string,
    conversationId: string,
    memberId: string,
    input: UpdateGroupMemberRoleDto,
  ): Promise<GroupConversationResponseDto> {
    const normalizedActorId = actorId.toLowerCase();
    const normalizedMemberId = memberId.toLowerCase();
    const now = this.clock.now();
    const result = await this.repository.updateGroupMemberRole({
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      memberId: normalizedMemberId,
      role: input.role === 'admin' ? 'ADMIN' : 'MEMBER',
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'forbidden') {
      throw this.groupForbiddenException();
    }
    if (result.status === 'member-not-found') {
      throw this.memberNotFoundException();
    }
    if (result.status === 'owner-protected') {
      throw this.ownerProtectedException();
    }
    if (result.status !== 'role-updated') {
      throw new Error(`Unexpected role-update status: ${result.status}`);
    }

    if (result.changed) {
      this.publishGroupChangedBestEffort({
        kind: 'member-role-updated',
        conversationId: result.conversation.id,
        actorId: normalizedActorId,
        recipientIds: result.eventRecipientIds,
        memberId: normalizedMemberId,
        role: input.role === 'admin' ? 'ADMIN' : 'MEMBER',
        occurredAt: now,
      });
    }
    return this.toResponse(result.conversation);
  }

  async transferGroupOwnership(
    actorId: string,
    conversationId: string,
    input: TransferGroupOwnershipDto,
  ): Promise<GroupConversationResponseDto> {
    const normalizedActorId = actorId.toLowerCase();
    const normalizedNewOwnerId = input.newOwnerId.toLowerCase();
    if (normalizedActorId === normalizedNewOwnerId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_OWNER_TRANSFER_SELF_NOT_ALLOWED',
        'Select another group member as the new owner.',
      );
    }

    const now = this.clock.now();
    const result = await this.repository.transferGroupOwnership({
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      memberId: normalizedNewOwnerId,
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'forbidden') {
      throw this.groupForbiddenException();
    }
    if (result.status === 'member-not-found') {
      throw this.memberNotFoundException();
    }
    if (result.status !== 'ownership-transferred') {
      throw new Error(`Unexpected ownership status: ${result.status}`);
    }

    if (result.changed) {
      this.publishGroupChangedBestEffort({
        kind: 'ownership-transferred',
        conversationId: result.conversation.id,
        actorId: normalizedActorId,
        recipientIds: result.eventRecipientIds,
        previousOwnerId: normalizedActorId,
        newOwnerId: normalizedNewOwnerId,
        occurredAt: now,
      });
    }
    return this.toResponse(result.conversation);
  }

  async leaveGroup(actorId: string, conversationId: string): Promise<void> {
    const normalizedActorId = actorId.toLowerCase();
    const now = this.clock.now();
    const result = await this.repository.leaveGroup({
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'owner-transfer-required') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONVERSATION_OWNER_TRANSFER_REQUIRED',
        'Transfer ownership before leaving the group.',
      );
    }
    if (result.status !== 'left') {
      throw new Error(`Unexpected leave-group status: ${result.status}`);
    }

    this.publishGroupChangedBestEffort({
      kind: 'member-removed',
      conversationId: conversationId.toLowerCase(),
      actorId: normalizedActorId,
      recipientIds: result.eventRecipientIds,
      memberId: normalizedActorId,
      reason: 'left',
      occurredAt: now,
    });
  }

  async deleteGroup(actorId: string, conversationId: string): Promise<void> {
    const normalizedActorId = actorId.toLowerCase();
    const normalizedConversationId = conversationId.toLowerCase();
    const now = this.clock.now();
    const result = await this.repository.deleteGroup({
      conversationId: normalizedConversationId,
      actorId: normalizedActorId,
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw this.notFoundException();
    }
    if (result.status === 'forbidden') {
      throw this.groupForbiddenException();
    }
    if (result.status !== 'deleted') {
      throw new Error(`Unexpected delete-group status: ${result.status}`);
    }

    this.publishGroupChangedBestEffort({
      kind: 'deleted',
      conversationId: normalizedConversationId,
      actorId: normalizedActorId,
      recipientIds: result.eventRecipientIds,
      occurredAt: now,
    });
  }

  private publishCreatedBestEffort(
    event: Parameters<ConversationEventsPublisher['publishCreated']>[0],
  ): void {
    try {
      void this.eventsPublisher.publishCreated(event).catch(() => {
        this.logger.warn(
          `Failed to publish conversation.created for ${event.conversationId}`,
        );
      });
    } catch {
      this.logger.warn(
        `Failed to publish conversation.created for ${event.conversationId}`,
      );
    }
  }

  private publishGroupChangedBestEffort(
    event: Parameters<ConversationEventsPublisher['publishGroupChanged']>[0],
  ): void {
    try {
      void this.eventsPublisher.publishGroupChanged(event).catch(() => {
        this.logger.warn(
          `Failed to publish ${event.kind} for ${event.conversationId}`,
        );
      });
    } catch {
      this.logger.warn(
        `Failed to publish ${event.kind} for ${event.conversationId}`,
      );
    }
  }

  async list(
    userId: string,
    limit: number,
    encodedCursor?: string,
    archived?: boolean,
  ): Promise<ConversationListResponseDto> {
    const archivedFilter = archived ?? false;
    const cursor =
      encodedCursor === undefined
        ? null
        : this.decodeCursor(encodedCursor, archivedFilter);
    const records =
      archived === undefined
        ? await this.repository.listForUser(userId, cursor, limit + 1)
        : await this.repository.listForUser(
            userId,
            cursor,
            limit + 1,
            archived,
          );
    const hasNextPage = records.length > limit;
    const pageRecords = records.slice(0, limit);
    const lastRecord = pageRecords.at(-1);

    return {
      items: pageRecords.map((record) => this.toResponse(record)),
      pageInfo: {
        nextCursor:
          hasNextPage && lastRecord
            ? this.encodeCursor(lastRecord, archivedFilter)
            : null,
        hasNextPage,
      },
    };
  }

  listArchived(
    userId: string,
    limit: number,
    encodedCursor?: string,
  ): Promise<ConversationListResponseDto> {
    return this.list(userId, limit, encodedCursor, true);
  }

  async get(
    userId: string,
    conversationId: string,
  ): Promise<ConversationResponseDto> {
    const conversation = await this.repository.findForUser(
      conversationId,
      userId,
    );
    if (!conversation) throw this.notFoundException();
    return this.toResponse(conversation);
  }

  private toResponse(
    record: DirectConversationRecord,
  ): DirectConversationResponseDto;
  private toResponse(
    record: GroupConversationRecord,
  ): GroupConversationResponseDto;
  private toResponse(record: ConversationRecord): ConversationResponseDto;
  private toResponse(record: ConversationRecord): ConversationResponseDto {
    const now = this.clock.now();
    const mutedAt = record.settings?.mutedAt ?? null;
    const mutedUntil = record.settings?.mutedUntil ?? null;
    const muted =
      mutedAt !== null &&
      (mutedUntil === null || mutedUntil.getTime() > now.getTime());
    const clearedAt = record.settings?.clearedAt ?? null;
    const clearedThroughMessageId =
      record.settings?.clearedThroughMessageId ?? null;
    const latestMessage =
      record.latestMessage &&
      this.isAfterClearBoundary(
        record.latestMessage,
        clearedAt,
        clearedThroughMessageId,
      )
        ? record.latestMessage
        : null;
    const common = {
      id: record.id,
      settings: {
        archived: record.settings?.archivedAt != null,
        muted,
        pinned: record.settings?.pinnedAt != null,
        favorited: record.settings?.favoritedAt != null,
        archivedAt: record.settings?.archivedAt?.toISOString() ?? null,
        mutedAt: mutedAt?.toISOString() ?? null,
        mutedUntil: mutedUntil?.toISOString() ?? null,
        pinnedAt: record.settings?.pinnedAt?.toISOString() ?? null,
        favoritedAt: record.settings?.favoritedAt?.toISOString() ?? null,
        clearedAt: clearedAt?.toISOString() ?? null,
        clearedThroughMessageId,
      },
      latestMessage: latestMessage
        ? {
            id: latestMessage.id,
            senderId: latestMessage.senderId,
            kind: 'text' as const,
            preview: this.messagePreview(latestMessage.text),
            createdAt: latestMessage.createdAt.toISOString(),
          }
        : null,
      unreadCount: record.unreadCount,
      lastActivityAt: record.lastActivityAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };

    if (record.type === 'DIRECT') {
      return {
        ...common,
        type: 'direct',
        otherParticipant: record.otherParticipant,
      };
    }

    return {
      ...common,
      type: 'group',
      name: record.name,
      avatarUrl: record.avatarUrl,
      participants: record.participants.map((participant) => ({
        id: participant.id,
        displayName: participant.displayName,
        avatarUrl: participant.avatarUrl,
        role: participant.role.toLowerCase() as 'owner' | 'admin' | 'member',
      })),
      role: record.role.toLowerCase() as 'owner' | 'admin' | 'member',
    };
  }

  private messagePreview(text: string): string {
    const codePoints = Array.from(text);
    if (codePoints.length <= MAX_MESSAGE_PREVIEW_CODE_POINTS) return text;
    return `${codePoints
      .slice(0, MAX_MESSAGE_PREVIEW_CODE_POINTS - 1)
      .join('')}…`;
  }

  private isAfterClearBoundary(
    message: ConversationLatestMessageRecord,
    clearedAt: Date | null,
    clearedThroughMessageId: string | null,
  ): boolean {
    if (!clearedAt || !clearedThroughMessageId) return true;
    const timeDifference = message.createdAt.getTime() - clearedAt.getTime();
    return (
      timeDifference > 0 ||
      (timeDifference === 0 && message.id > clearedThroughMessageId)
    );
  }

  private encodeCursor(record: ConversationRecord, archived: boolean): string {
    const cursor: SerializedCursor = {
      v: 2,
      pinned: record.settings?.pinnedAt != null,
      archived,
      lastActivityAt: record.lastActivityAt.toISOString(),
      id: record.id,
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(
    value: string,
    archived: boolean,
  ): ConversationPageCursor {
    try {
      if (
        value.length === 0 ||
        value.length > MAX_CURSOR_LENGTH ||
        !CURSOR_PATTERN.test(value)
      ) {
        throw new Error('Invalid cursor encoding.');
      }

      const decoded: unknown = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      );
      if (!this.isSerializedCursor(decoded)) {
        throw new Error('Invalid cursor payload.');
      }
      if (decoded.archived !== archived) {
        throw new Error('Cursor filter mismatch.');
      }

      const lastActivityAt = new Date(decoded.lastActivityAt);
      if (
        Number.isNaN(lastActivityAt.getTime()) ||
        lastActivityAt.toISOString() !== decoded.lastActivityAt
      ) {
        throw new Error('Invalid cursor timestamp.');
      }
      return {
        pinned: decoded.pinned,
        archived: decoded.archived,
        lastActivityAt,
        id: decoded.id,
      };
    } catch {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_CURSOR_INVALID',
        'The conversation cursor is invalid.',
      );
    }
  }

  private isSerializedCursor(value: unknown): value is SerializedCursor {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<SerializedCursor>;
    return (
      candidate.v === 2 &&
      typeof candidate.pinned === 'boolean' &&
      typeof candidate.archived === 'boolean' &&
      typeof candidate.lastActivityAt === 'string' &&
      typeof candidate.id === 'string' &&
      UUID_PATTERN.test(candidate.id)
    );
  }

  private notFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
      'The conversation was not found.',
    );
  }

  private groupForbiddenException(): ApiException {
    return new ApiException(
      HttpStatus.FORBIDDEN,
      'CONVERSATION_GROUP_PERMISSION_DENIED',
      'Your group role does not allow this action.',
    );
  }

  private memberNotFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'CONVERSATION_MEMBER_NOT_FOUND',
      'The selected group member was not found.',
    );
  }

  private ownerProtectedException(): ApiException {
    return new ApiException(
      HttpStatus.CONFLICT,
      'CONVERSATION_OWNER_PROTECTED',
      'The group owner must transfer ownership before this action.',
    );
  }
}

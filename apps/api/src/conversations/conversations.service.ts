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
import type {
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
      await this.publishCreatedBestEffort({
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

    await this.publishCreatedBestEffort({
      conversationId: result.conversation.id,
      type: 'GROUP',
      participantIds: result.conversation.participants.map(
        (participant) => participant.id,
      ),
      occurredAt: result.conversation.createdAt,
    });

    return this.toResponse(result.conversation);
  }

  private async publishCreatedBestEffort(
    event: Parameters<ConversationEventsPublisher['publishCreated']>[0],
  ): Promise<void> {
    try {
      await this.eventsPublisher.publishCreated(event);
    } catch {
      this.logger.warn(
        `Failed to publish conversation.created for ${event.conversationId}`,
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
    const common = {
      id: record.id,
      settings: {
        archived: record.settings?.archivedAt != null,
        muted: record.settings?.mutedAt != null,
        pinned: record.settings?.pinnedAt != null,
        archivedAt: record.settings?.archivedAt?.toISOString() ?? null,
        mutedAt: record.settings?.mutedAt?.toISOString() ?? null,
        pinnedAt: record.settings?.pinnedAt?.toISOString() ?? null,
      },
      latestMessage: record.latestMessage
        ? {
            id: record.latestMessage.id,
            senderId: record.latestMessage.senderId,
            kind: 'text' as const,
            preview: this.messagePreview(record.latestMessage.text),
            createdAt: record.latestMessage.createdAt.toISOString(),
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
}

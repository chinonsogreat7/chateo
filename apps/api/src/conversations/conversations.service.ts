import { HttpStatus, Injectable } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationsRepository } from './conversations.repository';
import type { ConversationListResponseDto } from './dto/conversation-response.dto';
import type { ConversationResponseDto } from './dto/conversation-response.dto';
import type {
  ConversationPageCursor,
  ConversationRecord,
} from './conversations.types';

interface SerializedCursor {
  v: 1;
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
  constructor(
    private readonly repository: ConversationsRepository,
    private readonly clock: Clock,
  ) {}

  async createDirect(
    userId: string,
    participantId: string,
  ): Promise<ConversationResponseDto> {
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

    return this.toResponse(result.conversation);
  }

  async list(
    userId: string,
    limit: number,
    encodedCursor?: string,
  ): Promise<ConversationListResponseDto> {
    const cursor =
      encodedCursor === undefined ? null : this.decodeCursor(encodedCursor);
    const records = await this.repository.listForUser(
      userId,
      cursor,
      limit + 1,
    );
    const hasNextPage = records.length > limit;
    const pageRecords = records.slice(0, limit);
    const lastRecord = pageRecords.at(-1);

    return {
      items: pageRecords.map((record) => this.toResponse(record)),
      pageInfo: {
        nextCursor:
          hasNextPage && lastRecord ? this.encodeCursor(lastRecord) : null,
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

  private toResponse(record: ConversationRecord): ConversationResponseDto {
    return {
      id: record.id,
      type: 'direct',
      otherParticipant: record.otherParticipant,
      latestMessage: record.latestMessage
        ? {
            id: record.latestMessage.id,
            senderId: record.latestMessage.senderId,
            kind: 'text',
            preview: this.messagePreview(record.latestMessage.text),
            createdAt: record.latestMessage.createdAt.toISOString(),
          }
        : null,
      unreadCount: record.unreadCount,
      lastActivityAt: record.lastActivityAt.toISOString(),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  private messagePreview(text: string): string {
    const codePoints = Array.from(text);
    if (codePoints.length <= MAX_MESSAGE_PREVIEW_CODE_POINTS) return text;
    return `${codePoints
      .slice(0, MAX_MESSAGE_PREVIEW_CODE_POINTS - 1)
      .join('')}…`;
  }

  private encodeCursor(record: ConversationRecord): string {
    const cursor: SerializedCursor = {
      v: 1,
      lastActivityAt: record.lastActivityAt.toISOString(),
      id: record.id,
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value: string): ConversationPageCursor {
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

      const lastActivityAt = new Date(decoded.lastActivityAt);
      if (
        Number.isNaN(lastActivityAt.getTime()) ||
        lastActivityAt.toISOString() !== decoded.lastActivityAt
      ) {
        throw new Error('Invalid cursor timestamp.');
      }
      return { lastActivityAt, id: decoded.id };
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
      candidate.v === 1 &&
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

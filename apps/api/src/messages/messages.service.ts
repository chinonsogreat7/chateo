import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { MessageEventsPublisher } from './message-events.publisher';
import { MessagesRepository } from './messages.repository';
import type {
  ClearConversationMessagesResponseDto,
  ConversationReadStateResponseDto,
  MessageHistoryResponseDto,
  MessageResponseDto,
} from './dto/message-response.dto';
import type { SendMessageDto } from './dto/send-message.dto';
import type {
  ConversationHistoryClearedRecord,
  MessagePageCursor,
  MessageRecord,
} from './messages.types';

interface SerializedMessageCursor {
  v: 1;
  createdAt: string;
  id: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const MAX_CURSOR_LENGTH = 512;

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(
    private readonly repository: MessagesRepository,
    private readonly clock: Clock,
    private readonly eventsPublisher: MessageEventsPublisher,
  ) {}

  async send(
    userId: string,
    conversationId: string,
    input: SendMessageDto,
  ): Promise<MessageResponseDto> {
    const result = await this.repository.sendText({
      conversationId: conversationId.toLowerCase(),
      senderId: userId.toLowerCase(),
      clientMessageId: input.clientMessageId.toLowerCase(),
      text: input.text.trim(),
      now: this.clock.now(),
    });

    if (result.status === 'conversation-not-found') {
      throw this.conversationNotFoundException();
    }
    if (result.status === 'idempotency-conflict') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MESSAGE_IDEMPOTENCY_CONFLICT',
        'The client message ID has already been used with different message data.',
      );
    }
    if (result.status === 'created') {
      this.publishCreatedBestEffort(result.message);
    }

    return this.toResponse(result.message);
  }

  async list(
    userId: string,
    conversationId: string,
    limit: number,
    encodedCursor?: string,
  ): Promise<MessageHistoryResponseDto> {
    const cursor =
      encodedCursor === undefined ? null : this.decodeCursor(encodedCursor);
    const result = await this.repository.listForMember(
      conversationId.toLowerCase(),
      userId.toLowerCase(),
      cursor,
      limit + 1,
    );
    if (result.status === 'conversation-not-found') {
      throw this.conversationNotFoundException();
    }

    const hasNextPage = result.messages.length > limit;
    const pageMessages = result.messages.slice(0, limit);
    const lastMessage = pageMessages.at(-1);
    return {
      items: pageMessages.map((message) => this.toResponse(message)),
      pageInfo: {
        nextCursor:
          hasNextPage && lastMessage ? this.encodeCursor(lastMessage) : null,
        hasNextPage,
      },
    };
  }

  async markRead(
    userId: string,
    conversationId: string,
  ): Promise<ConversationReadStateResponseDto> {
    const result = await this.repository.markRead(
      conversationId.toLowerCase(),
      userId.toLowerCase(),
      this.clock.now(),
    );
    if (result.status === 'conversation-not-found') {
      throw this.conversationNotFoundException();
    }

    return {
      conversationId: result.state.conversationId,
      lastReadAt: result.state.lastReadAt.toISOString(),
      unreadCount: result.state.unreadCount,
    };
  }

  async clear(
    userId: string,
    conversationId: string,
  ): Promise<ClearConversationMessagesResponseDto> {
    const result = await this.repository.clearForMember(
      conversationId.toLowerCase(),
      userId.toLowerCase(),
      this.clock.now(),
    );
    if (result.status === 'conversation-not-found') {
      throw this.conversationNotFoundException();
    }

    if (result.changed) {
      this.publishHistoryClearedBestEffort({
        conversationId: result.conversationId,
        userId: result.userId,
        changed: result.changed,
        clearedAt: result.clearedAt,
        clearedThroughMessageId: result.clearedThroughMessageId,
        occurredAt: result.occurredAt,
      });
    }

    return {
      conversationId: result.conversationId,
      changed: result.changed,
      clearedAt: result.clearedAt?.toISOString() ?? null,
      clearedThroughMessageId: result.clearedThroughMessageId,
    };
  }

  private publishCreatedBestEffort(message: MessageRecord): void {
    try {
      void this.eventsPublisher
        .publishCreated(message)
        .catch((error: unknown) => {
          this.logPublishError('message.created', message.id, error);
        });
    } catch (error) {
      this.logPublishError('message.created', message.id, error);
    }
  }

  private publishHistoryClearedBestEffort(
    record: ConversationHistoryClearedRecord,
  ): void {
    try {
      void this.eventsPublisher
        .publishHistoryCleared(record)
        .catch((error: unknown) => {
          this.logPublishError(
            'conversation.history.cleared',
            record.conversationId,
            error,
          );
        });
    } catch (error) {
      this.logPublishError(
        'conversation.history.cleared',
        record.conversationId,
        error,
      );
    }
  }

  private logPublishError(
    event: string,
    subject: string,
    error: unknown,
  ): void {
    this.logger.error(
      `Failed to publish ${event} for ${subject}`,
      error instanceof Error ? error.stack : undefined,
    );
  }

  private toResponse(message: MessageRecord): MessageResponseDto {
    return {
      id: message.id,
      conversationId: message.conversationId,
      clientMessageId: message.clientMessageId,
      senderId: message.senderId,
      kind: 'text',
      text: message.text,
      createdAt: message.createdAt.toISOString(),
    };
  }

  private encodeCursor(message: MessageRecord): string {
    const cursor: SerializedMessageCursor = {
      v: 1,
      createdAt: message.createdAt.toISOString(),
      id: message.id,
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value: string): MessagePageCursor {
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

      const createdAt = new Date(decoded.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString() !== decoded.createdAt
      ) {
        throw new Error('Invalid cursor timestamp.');
      }
      return { createdAt, id: decoded.id.toLowerCase() };
    } catch {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'MESSAGE_CURSOR_INVALID',
        'The message cursor is invalid.',
      );
    }
  }

  private isSerializedCursor(value: unknown): value is SerializedMessageCursor {
    if (typeof value !== 'object' || value === null) return false;
    const candidate = value as Partial<SerializedMessageCursor>;
    return (
      candidate.v === 1 &&
      typeof candidate.createdAt === 'string' &&
      typeof candidate.id === 'string' &&
      UUID_PATTERN.test(candidate.id)
    );
  }

  private conversationNotFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
      'The conversation was not found.',
    );
  }
}

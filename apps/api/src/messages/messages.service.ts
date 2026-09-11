import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { MessageEventsPublisher } from './message-events.publisher';
import { MessagesRepository } from './messages.repository';
import { messageResponse } from './message-mapping';
import type { EditMessageDto } from './dto/message-actions.dto';
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
  MessageMutation,
} from './messages.types';

interface SerializedMessageCursor {
  v: 1 | 2;
  scope?: string;
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
    const result = await this.repository.send({
      conversationId: conversationId.toLowerCase(),
      senderId: userId.toLowerCase(),
      clientMessageId: input.clientMessageId.toLowerCase(),
      ...(input.replyToMessageId
        ? { replyToMessageId: input.replyToMessageId.toLowerCase() }
        : {}),
      text: input.text?.trim() || null,
      attachmentMediaIds: (input.attachmentMediaIds ?? []).map((mediaId) =>
        mediaId.toLowerCase(),
      ),
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
    if (result.status === 'reply-unavailable') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MESSAGE_REPLY_UNAVAILABLE',
        'The reply target is unavailable in this conversation.',
      );
    }
    if (result.status === 'attachment-unavailable') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MESSAGE_ATTACHMENT_UNAVAILABLE',
        'One or more attachments are unavailable for this message.',
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
    query?: string,
  ): Promise<MessageHistoryResponseDto> {
    const scope =
      query === undefined
        ? undefined
        : createHash('sha256')
            .update(JSON.stringify([conversationId.toLowerCase(), query]))
            .digest('hex');
    const cursor =
      encodedCursor === undefined
        ? null
        : this.decodeCursor(encodedCursor, scope);
    const result = await this.repository.listForMember(
      conversationId.toLowerCase(),
      userId.toLowerCase(),
      cursor,
      limit + 1,
      ...(query === undefined ? [] : [query]),
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
          hasNextPage && lastMessage
            ? this.encodeCursor(lastMessage, scope)
            : null,
        hasNextPage,
      },
    };
  }

  async get(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MessageResponseDto> {
    const result = await this.repository.getForMember(
      conversationId.toLowerCase(),
      userId.toLowerCase(),
      messageId.toLowerCase(),
    );
    if (result.status === 'message-not-found')
      throw this.messageNotFoundException();
    return this.toResponse(result.message);
  }

  edit(
    userId: string,
    conversationId: string,
    messageId: string,
    input: EditMessageDto,
  ): Promise<MessageResponseDto> {
    return this.mutate(userId, conversationId, messageId, {
      kind: 'edit',
      text: input.text?.trim() || null,
      expectedVersion: input.expectedVersion,
    });
  }

  delete(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MessageResponseDto> {
    return this.mutate(userId, conversationId, messageId, { kind: 'delete' });
  }

  react(
    userId: string,
    conversationId: string,
    messageId: string,
    emoji: string | null,
  ): Promise<MessageResponseDto> {
    return this.mutate(userId, conversationId, messageId, {
      kind: 'reaction',
      emoji,
    });
  }

  private async mutate(
    userId: string,
    conversationId: string,
    messageId: string,
    mutation: MessageMutation,
  ): Promise<MessageResponseDto> {
    const result = await this.repository.mutate({
      actorId: userId.toLowerCase(),
      conversationId: conversationId.toLowerCase(),
      messageId: messageId.toLowerCase(),
      mutation,
      now: this.clock.now(),
    });
    if (result.status === 'message-not-found')
      throw this.messageNotFoundException();
    if (result.status === 'forbidden')
      throw new ApiException(
        HttpStatus.FORBIDDEN,
        'MESSAGE_SENDER_REQUIRED',
        'Only the sender can edit or delete this message.',
      );
    if (result.status === 'deleted')
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MESSAGE_DELETED',
        'Deleted messages cannot be edited or reacted to.',
      );
    if (result.status === 'version-conflict')
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MESSAGE_VERSION_CONFLICT',
        'This message changed. Read its latest version before editing.',
      );
    if (result.status === 'empty-text')
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'MESSAGE_TEXT_REQUIRED',
        'A text-only message cannot have an empty body.',
      );
    if (result.status !== 'updated')
      throw new Error(`Unexpected message mutation: ${result.status}`);
    if (result.changed) {
      try {
        void this.eventsPublisher
          .publishChanged(result.event)
          .catch((error: unknown) =>
            this.logPublishError('message.changed', messageId, error),
          );
      } catch (error) {
        this.logPublishError('message.changed', messageId, error);
      }
    }
    return this.toResponse(result.event.message);
  }

  private messageNotFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'MESSAGE_NOT_FOUND',
      'The message was not found.',
    );
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
    return messageResponse(message);
  }

  private encodeCursor(message: MessageRecord, scope?: string): string {
    const cursor: SerializedMessageCursor = {
      v: scope === undefined ? 1 : 2,
      ...(scope === undefined ? {} : { scope }),
      createdAt: message.createdAt.toISOString(),
      id: message.id,
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeCursor(value: string, scope?: string): MessagePageCursor {
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
      if (
        decoded.v !== (scope === undefined ? 1 : 2) ||
        decoded.scope !== scope
      )
        throw new Error('Cursor scope mismatch.');

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
      (candidate.v === 1 || candidate.v === 2) &&
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

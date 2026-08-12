import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import type {
  ReceiptFrontierResponseDto,
  ReceiptFrontiersResponseDto,
  ReceiptUpdateResponseDto,
} from './dto/receipt-response.dto';
import { ReceiptEventsPublisher } from './receipt-events.publisher';
import { ReceiptsRepository } from './receipts.repository';
import type {
  ReceiptFrontierRecord,
  ReceiptStatus,
  ReceiptUpdateRecord,
} from './receipts.types';

@Injectable()
export class ReceiptsService {
  private readonly logger = new Logger(ReceiptsService.name);

  constructor(
    private readonly repository: ReceiptsRepository,
    private readonly clock: Clock,
    private readonly eventsPublisher: ReceiptEventsPublisher,
  ) {}

  markDelivered(
    userId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<ReceiptUpdateResponseDto> {
    return this.mark(userId, conversationId, throughMessageId, 'DELIVERED');
  }

  markRead(
    userId: string,
    conversationId: string,
    throughMessageId: string,
  ): Promise<ReceiptUpdateResponseDto> {
    return this.mark(userId, conversationId, throughMessageId, 'READ');
  }

  async list(
    userId: string,
    conversationId: string,
  ): Promise<ReceiptFrontiersResponseDto> {
    const result = await this.repository.listForMember(
      conversationId.toLowerCase(),
      userId.toLowerCase(),
    );
    if (result.status === 'conversation-not-found') {
      throw this.conversationNotFoundException();
    }

    return {
      conversationId: result.conversationId,
      items: result.frontiers.map((frontier) =>
        this.toFrontierResponse(frontier),
      ),
    };
  }

  private async mark(
    userId: string,
    conversationId: string,
    throughMessageId: string,
    status: ReceiptStatus,
  ): Promise<ReceiptUpdateResponseDto> {
    const result = await this.repository.markThrough({
      conversationId: conversationId.toLowerCase(),
      userId: userId.toLowerCase(),
      throughMessageId: throughMessageId.toLowerCase(),
      status,
      now: this.clock.now(),
    });
    if (result.status === 'conversation-not-found') {
      throw this.conversationNotFoundException();
    }

    if (result.changed) {
      await this.publishBestEffort(result.receipt);
    }
    return this.toUpdateResponse(result.receipt, result.changed);
  }

  private async publishBestEffort(receipt: ReceiptUpdateRecord): Promise<void> {
    try {
      await this.eventsPublisher.publishUpdated(receipt);
    } catch (error) {
      this.logger.error(
        `Failed to publish receipt.${receipt.status.toLowerCase()} for ${receipt.throughMessageId}`,
        error instanceof Error ? error.stack : undefined,
      );
    }
  }

  private toUpdateResponse(
    receipt: ReceiptUpdateRecord,
    changed: boolean,
  ): ReceiptUpdateResponseDto {
    return {
      conversationId: receipt.conversationId,
      status: receipt.status === 'READ' ? 'read' : 'delivered',
      throughMessageId: receipt.throughMessageId,
      at: receipt.at.toISOString(),
      changed,
      unreadCount: receipt.unreadCount,
      version: receipt.version,
      delivered: {
        messageId: receipt.delivered.messageId,
        at: receipt.delivered.at.toISOString(),
      },
      read: receipt.read
        ? {
            messageId: receipt.read.messageId,
            at: receipt.read.at.toISOString(),
          }
        : null,
    };
  }

  private toFrontierResponse(
    frontier: ReceiptFrontierRecord,
  ): ReceiptFrontierResponseDto {
    return {
      userId: frontier.userId,
      version: frontier.version,
      delivered: frontier.delivered
        ? {
            messageId: frontier.delivered.messageId,
            at: frontier.delivered.at.toISOString(),
          }
        : null,
      read: frontier.read
        ? {
            messageId: frontier.read.messageId,
            at: frontier.read.at.toISOString(),
          }
        : null,
    };
  }

  private conversationNotFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'CONVERSATION_NOT_FOUND',
      'The conversation was not found.',
    );
  }
}

import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { ReceiptEventsPublisher } from '../receipts/receipt-events.publisher';
import type { ReceiptUpdateRecord } from '../receipts/receipts.types';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import {
  RECEIPT_DELIVERED_EVENT,
  RECEIPT_READ_EVENT,
  type ReceiptUpdatedEventPayload,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

@Injectable()
export class RealtimeReceiptEventsPublisher extends ReceiptEventsPublisher {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly repository: AuthRepository,
    private readonly conversations: RealtimeConversationsRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async publishUpdated(receipt: ReceiptUpdateRecord): Promise<void> {
    const participantIds = [...new Set(receipt.participantIds)];
    const participantIdSet = new Set(participantIds);
    const sockets = await this.gateway.findSocketsForUsers(participantIds);
    const event =
      receipt.status === 'READ' ? RECEIPT_READ_EVENT : RECEIPT_DELIVERED_EVENT;
    const payload: ReceiptUpdatedEventPayload = {
      conversationId: receipt.conversationId,
      userId: receipt.userId,
      throughMessageId: receipt.throughMessageId,
      at: receipt.at.toISOString(),
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

    await Promise.all(
      sockets.map((socket) =>
        this.emitToActiveSocket(
          socket,
          participantIdSet,
          receipt.userId,
          event,
          payload,
        ),
      ),
    );
  }

  private async emitToActiveSocket(
    socket: RealtimeSocketTarget,
    participantIds: ReadonlySet<string>,
    updatingUserId: string,
    event: typeof RECEIPT_DELIVERED_EVENT | typeof RECEIPT_READ_EVENT,
    payload: ReceiptUpdatedEventPayload,
  ): Promise<void> {
    const data = readSocketData(socket.data);
    const now = this.clock.now();
    if (
      !data ||
      !participantIds.has(data.userId) ||
      data.tokenExpiresAt <= now.getTime()
    ) {
      socket.disconnect(true);
      return;
    }

    try {
      const active = await this.repository.isSessionActive(
        data.sessionId,
        data.userId,
        now,
      );
      if (!active) {
        socket.disconnect(true);
        return;
      }

      if (
        data.userId !== updatingUserId &&
        !(await this.conversations.findAccessibleConversation(
          payload.conversationId,
          data.userId,
        ))
      ) {
        return;
      }
    } catch {
      socket.disconnect(true);
      return;
    }

    socket.emit(event, payload);
  }
}

function readSocketData(value: unknown): RealtimeSocketData | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<RealtimeSocketData>;
  if (
    typeof candidate.userId !== 'string' ||
    typeof candidate.sessionId !== 'string' ||
    typeof candidate.tokenExpiresAt !== 'number'
  ) {
    return null;
  }

  return {
    userId: candidate.userId,
    sessionId: candidate.sessionId,
    tokenExpiresAt: candidate.tokenExpiresAt,
  };
}

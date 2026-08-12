import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import type { MessageRecord } from '../messages/messages.types';
import { ChatGateway } from './chat.gateway';
import {
  MESSAGE_CREATED_EVENT,
  type MessageCreatedEventPayload,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

@Injectable()
export class RealtimeMessageEventsPublisher extends MessageEventsPublisher {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly repository: AuthRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async publishCreated(message: MessageRecord): Promise<void> {
    const participantIds = [
      ...new Set([...message.participantIds, message.senderId]),
    ];
    const participantIdSet = new Set(participantIds);
    const sockets = await this.gateway.findSocketsForUsers(participantIds);
    const payload = toMessageCreatedPayload(message);

    await Promise.all(
      sockets.map((socket) =>
        this.emitToActiveSocket(socket, participantIdSet, payload),
      ),
    );
  }

  private async emitToActiveSocket(
    socket: RealtimeSocketTarget,
    participantIds: ReadonlySet<string>,
    payload: MessageCreatedEventPayload,
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
    } catch {
      // Fail closed: an unverifiable socket must not receive private messages.
      socket.disconnect(true);
      return;
    }

    socket.emit(MESSAGE_CREATED_EVENT, payload);
  }
}

function toMessageCreatedPayload(
  message: MessageRecord,
): MessageCreatedEventPayload {
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

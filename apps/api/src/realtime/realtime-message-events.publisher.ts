import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import type { MessageRecord } from '../messages/messages.types';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import {
  MESSAGE_CREATED_EVENT,
  type MessageCreatedEventPayload,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

interface ActiveSocketCandidate {
  socket: RealtimeSocketTarget;
  data: RealtimeSocketData;
}

@Injectable()
export class RealtimeMessageEventsPublisher extends MessageEventsPublisher {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly repository: AuthRepository,
    private readonly conversations: RealtimeConversationsRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async publishCreated(message: MessageRecord): Promise<void> {
    let currentParticipantIds: ReadonlySet<string>;
    try {
      const currentConversation =
        await this.conversations.findAccessibleConversation(
          message.conversationId,
          message.senderId,
        );
      if (!currentConversation) return;
      currentParticipantIds = new Set(currentConversation.participantIds);
    } catch {
      return;
    }
    const participantIds = [
      ...new Set([...message.participantIds, message.senderId]),
    ].filter((userId) => currentParticipantIds.has(userId));
    const participantIdSet = new Set(participantIds);
    const sockets = await this.gateway.findSocketsForUsers(participantIds);
    const payload = toMessageCreatedPayload(message);
    const now = this.clock.now();
    const candidates: ActiveSocketCandidate[] = [];
    for (const socket of sockets) {
      const data = readSocketData(socket.data);
      if (
        !data ||
        !participantIdSet.has(data.userId) ||
        data.tokenExpiresAt <= now.getTime()
      ) {
        socket.disconnect(true);
        continue;
      }
      candidates.push({ socket, data });
    }

    let activeSessionIds: ReadonlySet<string>;
    try {
      activeSessionIds = new Set(
        await this.repository.findActiveSessionIds(
          candidates.map(({ data }) => ({
            sessionId: data.sessionId,
            userId: data.userId,
          })),
          now,
        ),
      );
    } catch {
      for (const { socket } of candidates) socket.disconnect(true);
      return;
    }

    await Promise.all(
      candidates.map(({ socket, data }) =>
        this.emitToActiveSocket(socket, data, activeSessionIds, payload),
      ),
    );
  }

  private async emitToActiveSocket(
    socket: RealtimeSocketTarget,
    data: RealtimeSocketData,
    activeSessionIds: ReadonlySet<string>,
    payload: MessageCreatedEventPayload,
  ): Promise<void> {
    if (!activeSessionIds.has(data.sessionId)) {
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

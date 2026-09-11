import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { messageResponse } from '../messages/message-mapping';
import type {
  ConversationHistoryClearedRecord,
  MessageRecord,
  MessageChangedRecord,
} from '../messages/messages.types';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import {
  CONVERSATION_HISTORY_CLEARED_EVENT,
  MESSAGE_CREATED_EVENT,
  MESSAGE_UPDATED_EVENT,
  MESSAGE_DELETED_EVENT,
  MESSAGE_REACTION_UPDATED_EVENT,
  type MessageChangedEventPayload,
  type ConversationHistoryClearedEventPayload,
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
    const payload = toMessageCreatedPayload(message);
    await this.publishToUsers(participantIds, MESSAGE_CREATED_EVENT, payload);
  }

  async publishChanged(record: MessageChangedRecord): Promise<void> {
    const access = await this.conversations.findAccessibleConversation(
      record.message.conversationId,
      record.actorId,
      record.message,
    );
    if (!access) return;
    const recipients = record.message.participantIds.filter((id) =>
      access.participantIds.includes(id),
    );
    const event =
      record.kind === 'updated'
        ? MESSAGE_UPDATED_EVENT
        : record.kind === 'deleted'
          ? MESSAGE_DELETED_EVENT
          : MESSAGE_REACTION_UPDATED_EVENT;
    await this.publishToUsers(recipients, event, {
      message: messageResponse(record.message),
      actorId: record.actorId,
      occurredAt: record.occurredAt.toISOString(),
    });
  }

  async publishHistoryCleared(
    record: ConversationHistoryClearedRecord,
  ): Promise<void> {
    const payload: ConversationHistoryClearedEventPayload = {
      conversationId: record.conversationId,
      userId: record.userId,
      clearedAt: record.clearedAt?.toISOString() ?? null,
      clearedThroughMessageId: record.clearedThroughMessageId,
      occurredAt: record.occurredAt.toISOString(),
    };
    await this.publishToUsers(
      [record.userId],
      CONVERSATION_HISTORY_CLEARED_EVENT,
      payload,
    );
  }

  private async publishToUsers(
    userIds: string[],
    event:
      | typeof MESSAGE_CREATED_EVENT
      | typeof MESSAGE_UPDATED_EVENT
      | typeof MESSAGE_DELETED_EVENT
      | typeof MESSAGE_REACTION_UPDATED_EVENT
      | typeof CONVERSATION_HISTORY_CLEARED_EVENT,
    payload:
      | MessageCreatedEventPayload
      | MessageChangedEventPayload
      | ConversationHistoryClearedEventPayload,
  ): Promise<void> {
    const uniqueUserIds = [...new Set(userIds)];
    const allowedUserIds = new Set(uniqueUserIds);
    const sockets = await this.gateway.findSocketsForUsers(uniqueUserIds);
    const now = this.clock.now();
    const candidates: ActiveSocketCandidate[] = [];
    for (const socket of sockets) {
      const data = readSocketData(socket.data);
      if (
        !data ||
        !allowedUserIds.has(data.userId) ||
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
        this.emitToActiveSocket(socket, data, activeSessionIds, event, payload),
      ),
    );
  }

  private async emitToActiveSocket(
    socket: RealtimeSocketTarget,
    data: RealtimeSocketData,
    activeSessionIds: ReadonlySet<string>,
    event:
      | typeof MESSAGE_CREATED_EVENT
      | typeof MESSAGE_UPDATED_EVENT
      | typeof MESSAGE_DELETED_EVENT
      | typeof MESSAGE_REACTION_UPDATED_EVENT
      | typeof CONVERSATION_HISTORY_CLEARED_EVENT,
    payload:
      | MessageCreatedEventPayload
      | MessageChangedEventPayload
      | ConversationHistoryClearedEventPayload,
  ): Promise<void> {
    if (!activeSessionIds.has(data.sessionId)) {
      socket.disconnect(true);
      return;
    }

    socket.emit(event, payload);
  }
}

function toMessageCreatedPayload(
  message: MessageRecord,
): MessageCreatedEventPayload {
  return messageResponse(message);
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

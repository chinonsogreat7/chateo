import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import {
  ConversationEventsPublisher,
  type ConversationCreatedEventRecord,
  type ConversationSettingsUpdatedEventRecord,
} from '../conversations/conversation-events.publisher';
import { ChatGateway } from './chat.gateway';
import {
  CONVERSATION_CREATED_EVENT,
  CONVERSATION_SETTINGS_UPDATED_EVENT,
  type ConversationCreatedEventPayload,
  type ConversationSettingsUpdatedEventPayload,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

type ConversationEventName =
  | typeof CONVERSATION_CREATED_EVENT
  | typeof CONVERSATION_SETTINGS_UPDATED_EVENT;
type ConversationEventPayload =
  | ConversationCreatedEventPayload
  | ConversationSettingsUpdatedEventPayload;

@Injectable()
export class RealtimeConversationEventsPublisher extends ConversationEventsPublisher {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly repository: AuthRepository,
    private readonly clock: Clock,
  ) {
    super();
  }

  async publishCreated(event: ConversationCreatedEventRecord): Promise<void> {
    const participantIds = [...new Set(event.participantIds)];
    const payload: ConversationCreatedEventPayload = {
      conversationId: event.conversationId,
      type: event.type.toLowerCase() as 'direct' | 'group',
      occurredAt: event.occurredAt.toISOString(),
    };
    await this.publishToUsers(
      participantIds,
      CONVERSATION_CREATED_EVENT,
      payload,
    );
  }

  async publishSettingsUpdated(
    event: ConversationSettingsUpdatedEventRecord,
  ): Promise<void> {
    const payload: ConversationSettingsUpdatedEventPayload = {
      conversationId: event.conversationId,
      userId: event.userId,
      archived: event.archivedAt !== null,
      muted: event.mutedAt !== null,
      pinned: event.pinnedAt !== null,
      archivedAt: event.archivedAt?.toISOString() ?? null,
      mutedAt: event.mutedAt?.toISOString() ?? null,
      pinnedAt: event.pinnedAt?.toISOString() ?? null,
      occurredAt: event.occurredAt.toISOString(),
    };
    await this.publishToUsers(
      [event.userId],
      CONVERSATION_SETTINGS_UPDATED_EVENT,
      payload,
    );
  }

  private async publishToUsers(
    userIds: string[],
    event: ConversationEventName,
    payload: ConversationEventPayload,
  ): Promise<void> {
    const allowedUserIds = new Set(userIds);
    const sockets = await this.gateway.findSocketsForUsers(userIds);
    await Promise.all(
      sockets.map((socket) =>
        this.emitToActiveSocket(socket, allowedUserIds, event, payload),
      ),
    );
  }

  private async emitToActiveSocket(
    socket: RealtimeSocketTarget,
    allowedUserIds: ReadonlySet<string>,
    event: ConversationEventName,
    payload: ConversationEventPayload,
  ): Promise<void> {
    const data = readSocketData(socket.data);
    const now = this.clock.now();
    if (
      !data ||
      !allowedUserIds.has(data.userId) ||
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

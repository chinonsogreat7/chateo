import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import {
  ConversationEventsPublisher,
  type ConversationCreatedEventRecord,
  type ConversationSettingsUpdatedEventRecord,
  type GroupChangedEventRecord,
} from '../conversations/conversation-events.publisher';
import { ChatStateService } from './chat-state.service';
import { ChatGateway } from './chat.gateway';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import {
  CONVERSATION_CREATED_EVENT,
  CONVERSATION_DELETED_EVENT,
  CONVERSATION_MEMBERS_ADDED_EVENT,
  CONVERSATION_MEMBER_REMOVED_EVENT,
  CONVERSATION_MEMBER_ROLE_UPDATED_EVENT,
  CONVERSATION_METADATA_UPDATED_EVENT,
  CONVERSATION_OWNER_TRANSFERRED_EVENT,
  CONVERSATION_SETTINGS_UPDATED_EVENT,
  type ConversationCreatedEventPayload,
  type ConversationDeletedEventPayload,
  type ConversationMembersAddedEventPayload,
  type ConversationMemberRemovedEventPayload,
  type ConversationMemberRoleUpdatedEventPayload,
  type ConversationMetadataUpdatedEventPayload,
  type ConversationOwnerTransferredEventPayload,
  type ConversationSettingsUpdatedEventPayload,
  type RealtimeSocketData,
  type RealtimeSocketTarget,
} from './realtime.types';

type ConversationEventName =
  | typeof CONVERSATION_CREATED_EVENT
  | typeof CONVERSATION_SETTINGS_UPDATED_EVENT
  | typeof CONVERSATION_METADATA_UPDATED_EVENT
  | typeof CONVERSATION_MEMBERS_ADDED_EVENT
  | typeof CONVERSATION_MEMBER_REMOVED_EVENT
  | typeof CONVERSATION_MEMBER_ROLE_UPDATED_EVENT
  | typeof CONVERSATION_OWNER_TRANSFERRED_EVENT
  | typeof CONVERSATION_DELETED_EVENT;
type ConversationEventPayload =
  | ConversationCreatedEventPayload
  | ConversationSettingsUpdatedEventPayload
  | ConversationMetadataUpdatedEventPayload
  | ConversationMembersAddedEventPayload
  | ConversationMemberRemovedEventPayload
  | ConversationMemberRoleUpdatedEventPayload
  | ConversationOwnerTransferredEventPayload
  | ConversationDeletedEventPayload;

interface CurrentAccessPolicy {
  conversationId: string;
  bypassUserIds?: ReadonlySet<string>;
  currentParticipantIds?: ReadonlySet<string>;
}

interface ActiveSocketCandidate {
  socket: RealtimeSocketTarget;
  data: RealtimeSocketData;
}

@Injectable()
export class RealtimeConversationEventsPublisher extends ConversationEventsPublisher {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly repository: AuthRepository,
    private readonly conversations: RealtimeConversationsRepository,
    private readonly state: ChatStateService,
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
    const accessPolicy: CurrentAccessPolicy = {
      conversationId: event.conversationId,
      ...(event.type === 'GROUP'
        ? {
            currentParticipantIds: new Set(
              (await this.conversations.findGroupParticipantIds(
                event.conversationId,
              )) ?? [],
            ),
          }
        : {}),
    };
    await this.publishToUsers(
      participantIds,
      CONVERSATION_CREATED_EVENT,
      payload,
      accessPolicy,
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

  async publishGroupChanged(event: GroupChangedEventRecord): Promise<void> {
    const notification = toGroupChangedNotification(event);
    const currentParticipantIds =
      event.kind === 'deleted'
        ? []
        : ((await this.conversations.findGroupParticipantIds(
            event.conversationId,
          )) ?? []);
    const accessPolicy: CurrentAccessPolicy | undefined =
      event.kind === 'deleted'
        ? undefined
        : {
            conversationId: event.conversationId,
            currentParticipantIds: new Set(currentParticipantIds),
            ...(event.kind === 'member-removed'
              ? { bypassUserIds: new Set([event.memberId]) }
              : {}),
          };

    // Existing subscribers must learn about the new member before the access
    // refresh emits that member's current presence snapshot.
    if (event.kind === 'members-added') {
      await this.publishToUsers(
        event.recipientIds,
        notification.name,
        notification.payload,
        accessPolicy,
      );
      await this.state.refreshConversationAccess(event.conversationId);
      return;
    }

    // Removed members must lose cached presence/typing access before their
    // final tombstone is emitted. Deletion follows the same fail-closed order.
    if (event.kind === 'member-removed' || event.kind === 'deleted') {
      await this.state.refreshConversationAccess(event.conversationId);
    }

    await this.publishToUsers(
      event.recipientIds,
      notification.name,
      notification.payload,
      accessPolicy,
    );
  }

  private async publishToUsers(
    userIds: string[],
    event: ConversationEventName,
    payload: ConversationEventPayload,
    accessPolicy?: CurrentAccessPolicy,
  ): Promise<void> {
    const uniqueUserIds = [...new Set(userIds)];
    const allowedUserIds = new Set(uniqueUserIds);
    const currentAccessByUserId = new Map<string, Promise<boolean>>();
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
        this.emitToActiveSocket(
          socket,
          data,
          activeSessionIds,
          event,
          payload,
          accessPolicy,
          currentAccessByUserId,
        ),
      ),
    );
  }

  private async emitToActiveSocket(
    socket: RealtimeSocketTarget,
    data: RealtimeSocketData,
    activeSessionIds: ReadonlySet<string>,
    event: ConversationEventName,
    payload: ConversationEventPayload,
    accessPolicy?: CurrentAccessPolicy,
    currentAccessByUserId = new Map<string, Promise<boolean>>(),
  ): Promise<void> {
    if (!activeSessionIds.has(data.sessionId)) {
      socket.disconnect(true);
      return;
    }

    try {
      if (
        accessPolicy &&
        !accessPolicy.bypassUserIds?.has(data.userId) &&
        !(
          accessPolicy.currentParticipantIds?.has(data.userId) ??
          (await this.hasCurrentAccess(
            accessPolicy.conversationId,
            data.userId,
            currentAccessByUserId,
          ))
        )
      ) {
        return;
      }
    } catch {
      socket.disconnect(true);
      return;
    }

    socket.emit(event, payload);
  }

  private hasCurrentAccess(
    conversationId: string,
    userId: string,
    currentAccessByUserId: Map<string, Promise<boolean>>,
  ): Promise<boolean> {
    const existing = currentAccessByUserId.get(userId);
    if (existing) return existing;

    const pending = this.conversations
      .findAccessibleConversation(conversationId, userId)
      .then((conversation) => conversation !== null);
    currentAccessByUserId.set(userId, pending);
    return pending;
  }
}

function toGroupChangedNotification(event: GroupChangedEventRecord): {
  name: ConversationEventName;
  payload: ConversationEventPayload;
} {
  const common = {
    conversationId: event.conversationId,
    actorId: event.actorId,
    occurredAt: event.occurredAt.toISOString(),
  };

  switch (event.kind) {
    case 'metadata-updated':
      return {
        name: CONVERSATION_METADATA_UPDATED_EVENT,
        payload: {
          ...common,
          name: event.name,
          avatarUrl: event.avatarUrl,
        },
      };
    case 'members-added':
      return {
        name: CONVERSATION_MEMBERS_ADDED_EVENT,
        payload: { ...common, memberIds: event.memberIds },
      };
    case 'member-removed':
      return {
        name: CONVERSATION_MEMBER_REMOVED_EVENT,
        payload: {
          ...common,
          memberId: event.memberId,
          reason: event.reason,
        },
      };
    case 'member-role-updated':
      return {
        name: CONVERSATION_MEMBER_ROLE_UPDATED_EVENT,
        payload: {
          ...common,
          memberId: event.memberId,
          role: event.role.toLowerCase() as 'admin' | 'member',
        },
      };
    case 'ownership-transferred':
      return {
        name: CONVERSATION_OWNER_TRANSFERRED_EVENT,
        payload: {
          ...common,
          previousOwnerId: event.previousOwnerId,
          newOwnerId: event.newOwnerId,
        },
      };
    case 'deleted':
      return { name: CONVERSATION_DELETED_EVENT, payload: common };
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

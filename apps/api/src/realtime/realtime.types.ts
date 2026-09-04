import type { Socket } from 'socket.io';

export const CHAT_NAMESPACE = '/chat';
export const MESSAGE_CREATED_EVENT = 'message.created';
export const CONVERSATION_HISTORY_CLEARED_EVENT =
  'conversation.history.cleared';
export const CONVERSATION_CREATED_EVENT = 'conversation.created';
export const CONVERSATION_SETTINGS_UPDATED_EVENT =
  'conversation.settings.updated';
export const CONVERSATION_METADATA_UPDATED_EVENT =
  'conversation.metadata.updated';
export const CONVERSATION_MEMBERS_ADDED_EVENT = 'conversation.members.added';
export const CONVERSATION_MEMBER_REMOVED_EVENT = 'conversation.member.removed';
export const CONVERSATION_MEMBER_ROLE_UPDATED_EVENT =
  'conversation.member.role.updated';
export const CONVERSATION_OWNER_TRANSFERRED_EVENT =
  'conversation.owner.transferred';
export const CONVERSATION_DELETED_EVENT = 'conversation.deleted';
export const RECEIPT_DELIVERED_EVENT = 'receipt.delivered';
export const RECEIPT_READ_EVENT = 'receipt.read';
export const PRESENCE_SUBSCRIBE_COMMAND = 'presence.subscribe';
export const PRESENCE_UNSUBSCRIBE_COMMAND = 'presence.unsubscribe';
export const PRESENCE_CHANGED_EVENT = 'presence.changed';
export const TYPING_START_COMMAND = 'typing.start';
export const TYPING_STOP_COMMAND = 'typing.stop';
export const TYPING_STARTED_EVENT = 'typing.started';
export const TYPING_STOPPED_EVENT = 'typing.stopped';
export const REALTIME_AUTH_ERROR_CODE = 'AUTH_ACCESS_TOKEN_INVALID';
export const REALTIME_AUTH_ERROR_MESSAGE = 'A valid access token is required.';
export const REALTIME_PAYLOAD_ERROR_CODE = 'REALTIME_PAYLOAD_INVALID';
export const REALTIME_PAYLOAD_ERROR_MESSAGE =
  'Payload must contain a valid conversationId.';
export const REALTIME_CONVERSATION_ERROR_CODE =
  'REALTIME_CONVERSATION_NOT_FOUND';
export const REALTIME_CONVERSATION_ERROR_MESSAGE =
  'Conversation was not found.';
export const REALTIME_RATE_LIMIT_ERROR_CODE = 'REALTIME_RATE_LIMITED';
export const REALTIME_RATE_LIMIT_ERROR_MESSAGE = 'Too many realtime requests.';
export const REALTIME_INTERNAL_ERROR_CODE = 'REALTIME_INTERNAL_ERROR';
export const REALTIME_INTERNAL_ERROR_MESSAGE =
  'The realtime request could not be completed.';

export interface RealtimeSocketData {
  userId: string;
  sessionId: string;
  tokenExpiresAt: number;
}

export interface ConversationCommandPayload {
  conversationId: string;
}

export type RealtimeErrorCode =
  | typeof REALTIME_AUTH_ERROR_CODE
  | typeof REALTIME_PAYLOAD_ERROR_CODE
  | typeof REALTIME_CONVERSATION_ERROR_CODE
  | typeof REALTIME_RATE_LIMIT_ERROR_CODE
  | typeof REALTIME_INTERNAL_ERROR_CODE;

export type RealtimeAck<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: RealtimeErrorCode;
        message: string;
      };
    };

export type RealtimeAckCallback<T> = (response: RealtimeAck<T>) => void;

export interface PresenceParticipantState {
  userId: string;
  status: 'online' | 'offline';
}

export interface PresenceSubscriptionData {
  conversationId: string;
  participants: PresenceParticipantState[];
  typing: Array<{
    userId: string;
    expiresAt: string;
  }>;
}

export interface PresenceUnsubscriptionData {
  conversationId: string;
}

export interface TypingStartedData {
  conversationId: string;
  expiresAt: string;
}

export interface TypingStoppedData {
  conversationId: string;
}

export interface ChatClientToServerEvents {
  [PRESENCE_SUBSCRIBE_COMMAND](
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<PresenceSubscriptionData>,
  ): void;
  [PRESENCE_UNSUBSCRIBE_COMMAND](
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<PresenceUnsubscriptionData>,
  ): void;
  [TYPING_START_COMMAND](
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<TypingStartedData>,
  ): void;
  [TYPING_STOP_COMMAND](
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<TypingStoppedData>,
  ): void;
}

export interface ChatServerToClientEvents {
  [CONVERSATION_CREATED_EVENT](payload: ConversationCreatedEventPayload): void;
  [CONVERSATION_SETTINGS_UPDATED_EVENT](
    payload: ConversationSettingsUpdatedEventPayload,
  ): void;
  [CONVERSATION_METADATA_UPDATED_EVENT](
    payload: ConversationMetadataUpdatedEventPayload,
  ): void;
  [CONVERSATION_MEMBERS_ADDED_EVENT](
    payload: ConversationMembersAddedEventPayload,
  ): void;
  [CONVERSATION_MEMBER_REMOVED_EVENT](
    payload: ConversationMemberRemovedEventPayload,
  ): void;
  [CONVERSATION_MEMBER_ROLE_UPDATED_EVENT](
    payload: ConversationMemberRoleUpdatedEventPayload,
  ): void;
  [CONVERSATION_OWNER_TRANSFERRED_EVENT](
    payload: ConversationOwnerTransferredEventPayload,
  ): void;
  [CONVERSATION_DELETED_EVENT](payload: ConversationDeletedEventPayload): void;
  [MESSAGE_CREATED_EVENT](payload: MessageCreatedEventPayload): void;
  [CONVERSATION_HISTORY_CLEARED_EVENT](
    payload: ConversationHistoryClearedEventPayload,
  ): void;
  [RECEIPT_DELIVERED_EVENT](payload: ReceiptUpdatedEventPayload): void;
  [RECEIPT_READ_EVENT](payload: ReceiptUpdatedEventPayload): void;
  [PRESENCE_CHANGED_EVENT](payload: PresenceChangedEventPayload): void;
  [TYPING_STARTED_EVENT](payload: TypingStartedEventPayload): void;
  [TYPING_STOPPED_EVENT](payload: TypingStoppedEventPayload): void;
}

export interface ConversationCreatedEventPayload {
  conversationId: string;
  type: 'direct' | 'group';
  occurredAt: string;
}

export interface ConversationSettingsUpdatedEventPayload {
  conversationId: string;
  userId: string;
  archived: boolean;
  muted: boolean;
  pinned: boolean;
  favorited: boolean;
  archivedAt: string | null;
  mutedAt: string | null;
  mutedUntil: string | null;
  pinnedAt: string | null;
  favoritedAt: string | null;
  occurredAt: string;
}

interface GroupChangedEventPayloadBase {
  conversationId: string;
  actorId: string;
  occurredAt: string;
}

export interface ConversationMetadataUpdatedEventPayload
  extends GroupChangedEventPayloadBase {
  name: string;
  avatarUrl: string | null;
}

export interface ConversationMembersAddedEventPayload
  extends GroupChangedEventPayloadBase {
  memberIds: string[];
}

export interface ConversationMemberRemovedEventPayload
  extends GroupChangedEventPayloadBase {
  memberId: string;
  reason: 'removed' | 'left';
}

export interface ConversationMemberRoleUpdatedEventPayload
  extends GroupChangedEventPayloadBase {
  memberId: string;
  role: 'admin' | 'member';
}

export interface ConversationOwnerTransferredEventPayload
  extends GroupChangedEventPayloadBase {
  previousOwnerId: string;
  newOwnerId: string;
}

export type ConversationDeletedEventPayload = GroupChangedEventPayloadBase;

export type AuthenticatedChatSocket = Socket<
  ChatClientToServerEvents,
  ChatServerToClientEvents,
  Record<string, never>,
  RealtimeSocketData
>;

export interface MessageCreatedEventPayload {
  id: string;
  conversationId: string;
  clientMessageId: string;
  senderId: string;
  kind: 'text';
  text: string;
  createdAt: string;
}

export interface ConversationHistoryClearedEventPayload {
  conversationId: string;
  userId: string;
  clearedAt: string | null;
  clearedThroughMessageId: string | null;
  occurredAt: string;
}

export interface ReceiptUpdatedEventPayload {
  conversationId: string;
  userId: string;
  throughMessageId: string;
  at: string;
  version: number;
  delivered: {
    messageId: string;
    at: string;
  };
  read: {
    messageId: string;
    at: string;
  } | null;
}

export interface PresenceChangedEventPayload {
  conversationId: string;
  userId: string;
  status: 'online' | 'offline';
  occurredAt: string;
}

export interface TypingStartedEventPayload {
  conversationId: string;
  userId: string;
  expiresAt: string;
}

export interface TypingStoppedEventPayload {
  conversationId: string;
  userId: string;
  occurredAt: string;
}

export interface RealtimeSocketTarget {
  id: string;
  data: unknown;
  emit(event: string, payload: unknown): boolean;
  disconnect(close?: boolean): unknown;
}

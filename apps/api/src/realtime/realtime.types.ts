import type { Socket } from 'socket.io';

export const CHAT_NAMESPACE = '/chat';
export const MESSAGE_CREATED_EVENT = 'message.created';
export const REALTIME_AUTH_ERROR_CODE = 'AUTH_ACCESS_TOKEN_INVALID';
export const REALTIME_AUTH_ERROR_MESSAGE = 'A valid access token is required.';

export interface RealtimeSocketData {
  userId: string;
  sessionId: string;
  tokenExpiresAt: number;
}

export type AuthenticatedChatSocket = Socket<
  Record<string, never>,
  Record<string, never>,
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

export interface RealtimeSocketTarget {
  id: string;
  data: unknown;
  emit(event: string, payload: MessageCreatedEventPayload): boolean;
  disconnect(close?: boolean): unknown;
}

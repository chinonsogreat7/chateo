export interface MessageReplyRecord {
  id: string;
  senderId: string;
  kind: 'TEXT';
  preview: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  clientMessageId: string;
  senderId: string;
  replyToMessageId: string | null;
  replyTo: MessageReplyRecord | null;
  kind: 'TEXT';
  text: string;
  createdAt: Date;
  /** Internal routing metadata. This is intentionally omitted from REST DTOs. */
  participantIds: string[];
}

export interface MessagePageCursor {
  createdAt: Date;
  id: string;
}

export interface MessageReadStateRecord {
  conversationId: string;
  lastReadAt: Date;
  unreadCount: number;
}

export type SendTextMessageResult =
  | { status: 'created' | 'existing'; message: MessageRecord }
  | { status: 'conversation-not-found' }
  | { status: 'reply-message-not-found' }
  | { status: 'idempotency-conflict' };

export type ListMessagesResult =
  | { status: 'found'; messages: MessageRecord[] }
  | { status: 'conversation-not-found' };

export type MarkConversationReadResult =
  | { status: 'updated'; state: MessageReadStateRecord }
  | { status: 'conversation-not-found' };

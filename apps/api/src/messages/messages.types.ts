interface MessageAttachmentRecordBase {
  mediaId: string;
  contentType: string;
  sizeBytes: number;
  url: string;
}

export interface ImageMessageAttachmentRecord
  extends MessageAttachmentRecordBase {
  type: 'image';
  width: number;
  height: number;
}

export interface AudioMessageAttachmentRecord
  extends MessageAttachmentRecordBase {
  type: 'audio';
  durationMs: number;
}

export type MessageAttachmentRecord =
  | ImageMessageAttachmentRecord
  | AudioMessageAttachmentRecord;

export interface MessageRecord {
  id: string;
  conversationId: string;
  clientMessageId: string;
  senderId: string;
  kind: 'TEXT' | 'IMAGE' | 'AUDIO';
  text: string | null;
  attachments: MessageAttachmentRecord[];
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

export interface ConversationHistoryClearedRecord {
  conversationId: string;
  userId: string;
  changed: boolean;
  clearedAt: Date | null;
  clearedThroughMessageId: string | null;
  occurredAt: Date;
}

export type SendMessageResult =
  | { status: 'created' | 'existing'; message: MessageRecord }
  | { status: 'conversation-not-found' }
  | { status: 'idempotency-conflict' }
  | { status: 'attachment-unavailable' };

/** @deprecated Use SendMessageResult. Kept for repository test doubles. */
export type SendTextMessageResult = SendMessageResult;

export type ListMessagesResult =
  | { status: 'found'; messages: MessageRecord[] }
  | { status: 'conversation-not-found' };

export type MarkConversationReadResult =
  | { status: 'updated'; state: MessageReadStateRecord }
  | { status: 'conversation-not-found' };

export type ClearConversationMessagesResult =
  | ({ status: 'cleared' } & ConversationHistoryClearedRecord)
  | { status: 'conversation-not-found' };

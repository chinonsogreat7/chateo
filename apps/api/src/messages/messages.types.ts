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

export interface VideoMessageAttachmentRecord
  extends MessageAttachmentRecordBase {
  type: 'video';
  width: number;
  height: number;
  durationMs: number;
}

export interface DocumentMessageAttachmentRecord
  extends MessageAttachmentRecordBase {
  type: 'document';
  filename: string;
}

export type MessageAttachmentRecord =
  | ImageMessageAttachmentRecord
  | AudioMessageAttachmentRecord
  | VideoMessageAttachmentRecord
  | DocumentMessageAttachmentRecord;

export interface MessageRecord {
  id: string;
  conversationId: string;
  clientMessageId: string;
  senderId: string;
  kind: 'TEXT' | 'IMAGE' | 'AUDIO' | 'VIDEO' | 'DOCUMENT';
  text: string | null;
  attachments: MessageAttachmentRecord[];
  createdAt: Date;
  replyToMessageId?: string | null;
  editedAt?: Date | null;
  deletedAt?: Date | null;
  version?: number;
  reactions?: Array<{ userId: string; emoji: string }>;
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
  | { status: 'reply-unavailable' }
  | { status: 'attachment-unavailable' };

export type MessageMutation =
  | { kind: 'edit'; text: string | null; expectedVersion: number }
  | { kind: 'delete' }
  | { kind: 'reaction'; emoji: string | null };

export interface MessageChangedRecord {
  kind: 'updated' | 'deleted' | 'reaction-updated';
  actorId: string;
  message: MessageRecord;
  occurredAt: Date;
}

export type MutateMessageResult =
  | { status: 'updated'; changed: boolean; event: MessageChangedRecord }
  | {
      status:
        | 'message-not-found'
        | 'forbidden'
        | 'deleted'
        | 'version-conflict'
        | 'empty-text';
    };

export type GetMessageResult =
  | { status: 'found'; message: MessageRecord }
  | { status: 'message-not-found' };

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

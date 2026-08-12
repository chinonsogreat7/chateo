export type ReceiptStatus = 'DELIVERED' | 'READ';

export interface ReceiptBoundaryRecord {
  messageId: string;
  at: Date;
}

export interface ReceiptFrontierRecord {
  userId: string;
  version: number;
  delivered: ReceiptBoundaryRecord | null;
  read: ReceiptBoundaryRecord | null;
}

export interface ReceiptUpdateRecord {
  conversationId: string;
  userId: string;
  status: ReceiptStatus;
  throughMessageId: string;
  at: Date;
  version: number;
  delivered: ReceiptBoundaryRecord;
  read: ReceiptBoundaryRecord | null;
  unreadCount: number;
  /** Internal routing metadata. This is intentionally omitted from REST DTOs. */
  participantIds: string[];
}

export type MarkReceiptResult =
  | {
      status: 'updated';
      changed: boolean;
      receipt: ReceiptUpdateRecord;
    }
  | { status: 'conversation-not-found' };

export type ListReceiptFrontiersResult =
  | {
      status: 'found';
      conversationId: string;
      frontiers: ReceiptFrontierRecord[];
    }
  | { status: 'conversation-not-found' };

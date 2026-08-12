export interface ConversationParticipantRecord {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface ConversationRecord {
  id: string;
  type: 'DIRECT';
  otherParticipant: ConversationParticipantRecord;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConversationPageCursor {
  lastActivityAt: Date;
  id: string;
}

export type CreateDirectConversationResult =
  | { status: 'created' | 'existing'; conversation: ConversationRecord }
  | { status: 'participant-not-found' };

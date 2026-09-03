export interface ConversationParticipantRecord {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export type ConversationMemberRoleRecord = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface GroupConversationParticipantRecord
  extends ConversationParticipantRecord {
  role: ConversationMemberRoleRecord;
}

export interface ConversationLatestMessageRecord {
  id: string;
  senderId: string;
  kind: 'TEXT';
  text: string;
  createdAt: Date;
}

interface ConversationRecordBase {
  id: string;
  settings?: {
    archivedAt: Date | null;
    mutedAt: Date | null;
    pinnedAt: Date | null;
  };
  latestMessage: ConversationLatestMessageRecord | null;
  unreadCount: number;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface DirectConversationRecord extends ConversationRecordBase {
  type: 'DIRECT';
  otherParticipant: ConversationParticipantRecord;
  name?: never;
  avatarUrl?: never;
  participants?: never;
  role?: never;
}

export interface GroupConversationRecord extends ConversationRecordBase {
  type: 'GROUP';
  otherParticipant?: never;
  name: string;
  avatarUrl: string | null;
  participants: GroupConversationParticipantRecord[];
  role: ConversationMemberRoleRecord;
}

export type ConversationRecord =
  | DirectConversationRecord
  | GroupConversationRecord;

export interface ConversationPageCursor {
  pinned: boolean;
  archived: boolean;
  lastActivityAt: Date;
  id: string;
}

export type CreateDirectConversationResult =
  | { status: 'created' | 'existing'; conversation: ConversationRecord }
  | { status: 'participant-not-found' };

export interface CreateGroupConversationInput {
  creatorId: string;
  name: string;
  avatarUrl: string | null;
  participantIds: string[];
  now: Date;
}

export type CreateGroupConversationResult =
  | { status: 'created'; conversation: GroupConversationRecord }
  | { status: 'participant-not-found' };

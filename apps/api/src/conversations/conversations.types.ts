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

interface GroupMutationInputBase {
  conversationId: string;
  actorId: string;
  now: Date;
}

interface GroupMutationSuccessBase {
  eventRecipientIds: string[];
}

interface GroupMutationWithConversationSuccess
  extends GroupMutationSuccessBase {
  conversation: GroupConversationRecord;
}

export interface UpdateGroupInput extends GroupMutationInputBase {
  name?: string;
  avatarUrl?: string | null;
}

export type UpdateGroupResult =
  | (GroupMutationWithConversationSuccess & {
      status: 'updated';
      changed: boolean;
    })
  | { status: 'conversation-not-found' | 'forbidden' };

export interface AddGroupMembersInput extends GroupMutationInputBase {
  participantIds: string[];
}

export type AddGroupMembersResult =
  | (GroupMutationWithConversationSuccess & { status: 'members-added' })
  | {
      status:
        | 'conversation-not-found'
        | 'forbidden'
        | 'participant-not-found'
        | 'member-already-exists'
        | 'group-full';
    };

export interface RemoveGroupMemberInput extends GroupMutationInputBase {
  memberId: string;
}

export type RemoveGroupMemberResult =
  | (GroupMutationWithConversationSuccess & { status: 'member-removed' })
  | {
      status:
        | 'conversation-not-found'
        | 'forbidden'
        | 'member-not-found'
        | 'owner-protected';
    };

export interface UpdateGroupMemberRoleInput extends GroupMutationInputBase {
  memberId: string;
  role: Exclude<ConversationMemberRoleRecord, 'OWNER'>;
}

export type UpdateGroupMemberRoleResult =
  | (GroupMutationWithConversationSuccess & {
      status: 'role-updated';
      changed: boolean;
    })
  | {
      status:
        | 'conversation-not-found'
        | 'forbidden'
        | 'member-not-found'
        | 'owner-protected';
    };

export interface TransferGroupOwnershipInput extends GroupMutationInputBase {
  memberId: string;
}

export type TransferGroupOwnershipResult =
  | (GroupMutationWithConversationSuccess & {
      status: 'ownership-transferred';
      changed: boolean;
    })
  | {
      status: 'conversation-not-found' | 'forbidden' | 'member-not-found';
    };

export type LeaveGroupInput = GroupMutationInputBase;

export type LeaveGroupResult =
  | (GroupMutationSuccessBase & { status: 'left' })
  | {
      status: 'conversation-not-found' | 'owner-transfer-required';
    };

export type DeleteGroupInput = GroupMutationInputBase;

export type DeleteGroupResult =
  | (GroupMutationSuccessBase & { status: 'deleted' })
  | { status: 'conversation-not-found' | 'forbidden' };

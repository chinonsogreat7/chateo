import type {
  AddGroupMembersInput,
  AddGroupMembersResult,
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
  CreateGroupConversationInput,
  CreateGroupConversationResult,
  DeleteGroupInput,
  DeleteGroupResult,
  LeaveGroupInput,
  LeaveGroupResult,
  RemoveGroupMemberInput,
  RemoveGroupMemberResult,
  TransferGroupOwnershipInput,
  TransferGroupOwnershipResult,
  UpdateGroupInput,
  UpdateGroupMemberRoleInput,
  UpdateGroupMemberRoleResult,
  UpdateGroupResult,
} from './conversations.types';

export abstract class ConversationsRepository {
  abstract createOrGetDirect(
    userId: string,
    participantId: string,
    now: Date,
  ): Promise<CreateDirectConversationResult>;

  abstract createGroup(
    input: CreateGroupConversationInput,
  ): Promise<CreateGroupConversationResult>;

  abstract updateGroup(input: UpdateGroupInput): Promise<UpdateGroupResult>;

  abstract addGroupMembers(
    input: AddGroupMembersInput,
  ): Promise<AddGroupMembersResult>;

  abstract removeGroupMember(
    input: RemoveGroupMemberInput,
  ): Promise<RemoveGroupMemberResult>;

  abstract updateGroupMemberRole(
    input: UpdateGroupMemberRoleInput,
  ): Promise<UpdateGroupMemberRoleResult>;

  abstract transferGroupOwnership(
    input: TransferGroupOwnershipInput,
  ): Promise<TransferGroupOwnershipResult>;

  abstract leaveGroup(input: LeaveGroupInput): Promise<LeaveGroupResult>;

  abstract deleteGroup(input: DeleteGroupInput): Promise<DeleteGroupResult>;

  abstract listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
    archived?: boolean,
  ): Promise<ConversationRecord[]>;

  abstract findForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationRecord | null>;
}

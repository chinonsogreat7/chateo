import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
  CreateGroupConversationInput,
  CreateGroupConversationResult,
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

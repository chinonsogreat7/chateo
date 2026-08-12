import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
} from './conversations.types';

export abstract class ConversationsRepository {
  abstract createOrGetDirect(
    userId: string,
    participantId: string,
    now: Date,
  ): Promise<CreateDirectConversationResult>;

  abstract listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
  ): Promise<ConversationRecord[]>;

  abstract findForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationRecord | null>;
}

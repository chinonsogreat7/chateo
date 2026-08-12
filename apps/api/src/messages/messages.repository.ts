import type {
  ListMessagesResult,
  MarkConversationReadResult,
  MessagePageCursor,
  SendTextMessageResult,
} from './messages.types';

export interface SendTextMessageInput {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  replyToMessageId?: string | null;
  text: string;
  now: Date;
}

export abstract class MessagesRepository {
  abstract sendText(
    input: SendTextMessageInput,
  ): Promise<SendTextMessageResult>;

  abstract listForMember(
    conversationId: string,
    userId: string,
    cursor: MessagePageCursor | null,
    take: number,
  ): Promise<ListMessagesResult>;

  abstract markRead(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<MarkConversationReadResult>;
}

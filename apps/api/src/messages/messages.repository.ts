import type {
  ClearConversationMessagesResult,
  ListMessagesResult,
  MarkConversationReadResult,
  MessagePageCursor,
  SendMessageResult,
  GetMessageResult,
  MutateMessageResult,
  MessageMutation,
} from './messages.types';

export interface SendMessageInput {
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  text: string | null;
  attachmentMediaIds: string[];
  replyToMessageId?: string | null;
  now: Date;
}

export type SendTextMessageInput = Omit<
  SendMessageInput,
  'text' | 'attachmentMediaIds'
> & {
  text: string;
};

export abstract class MessagesRepository {
  abstract send(input: SendMessageInput): Promise<SendMessageResult>;

  sendText(input: SendTextMessageInput): Promise<SendMessageResult> {
    return this.send({ ...input, attachmentMediaIds: [] });
  }

  abstract listForMember(
    conversationId: string,
    userId: string,
    cursor: MessagePageCursor | null,
    take: number,
    query?: string,
  ): Promise<ListMessagesResult>;

  abstract getForMember(
    conversationId: string,
    userId: string,
    messageId: string,
  ): Promise<GetMessageResult>;

  abstract mutate(input: {
    conversationId: string;
    actorId: string;
    messageId: string;
    mutation: MessageMutation;
    now: Date;
  }): Promise<MutateMessageResult>;

  abstract markRead(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<MarkConversationReadResult>;

  abstract clearForMember(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<ClearConversationMessagesResult>;
}

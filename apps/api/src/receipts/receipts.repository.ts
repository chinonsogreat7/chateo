import type {
  ListReceiptFrontiersResult,
  MarkReceiptResult,
  ReceiptStatus,
} from './receipts.types';

export interface MarkReceiptThroughInput {
  conversationId: string;
  userId: string;
  throughMessageId: string;
  status: ReceiptStatus;
  now: Date;
}

export abstract class ReceiptsRepository {
  abstract markThrough(
    input: MarkReceiptThroughInput,
  ): Promise<MarkReceiptResult>;

  abstract listForMember(
    conversationId: string,
    userId: string,
  ): Promise<ListReceiptFrontiersResult>;
}

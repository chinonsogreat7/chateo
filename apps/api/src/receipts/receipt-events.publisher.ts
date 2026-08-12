import type { ReceiptUpdateRecord } from './receipts.types';

export abstract class ReceiptEventsPublisher {
  abstract publishUpdated(receipt: ReceiptUpdateRecord): Promise<void>;
}

export class NoopReceiptEventsPublisher extends ReceiptEventsPublisher {
  publishUpdated(_receipt: ReceiptUpdateRecord): Promise<void> {
    return Promise.resolve();
  }
}

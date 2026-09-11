import { Injectable } from '@nestjs/common';
import type {
  ConversationHistoryClearedRecord,
  MessageRecord,
  MessageChangedRecord,
} from './messages.types';

export abstract class MessageEventsPublisher {
  abstract publishCreated(message: MessageRecord): Promise<void>;
  abstract publishChanged(event: MessageChangedRecord): Promise<void>;
  abstract publishHistoryCleared(
    record: ConversationHistoryClearedRecord,
  ): Promise<void>;
}

@Injectable()
export class NoopMessageEventsPublisher extends MessageEventsPublisher {
  publishChanged(_event: MessageChangedRecord): Promise<void> {
    return Promise.resolve();
  }

  publishCreated(_message: MessageRecord): Promise<void> {
    return Promise.resolve();
  }

  publishHistoryCleared(
    _record: ConversationHistoryClearedRecord,
  ): Promise<void> {
    return Promise.resolve();
  }
}

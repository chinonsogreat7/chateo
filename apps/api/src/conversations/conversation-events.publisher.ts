import { Injectable } from '@nestjs/common';

export interface ConversationCreatedEventRecord {
  conversationId: string;
  type: 'DIRECT' | 'GROUP';
  participantIds: string[];
  occurredAt: Date;
}

export interface ConversationSettingsUpdatedEventRecord {
  conversationId: string;
  userId: string;
  archivedAt: Date | null;
  mutedAt: Date | null;
  pinnedAt: Date | null;
  occurredAt: Date;
}

export abstract class ConversationEventsPublisher {
  abstract publishCreated(event: ConversationCreatedEventRecord): Promise<void>;

  abstract publishSettingsUpdated(
    event: ConversationSettingsUpdatedEventRecord,
  ): Promise<void>;
}

@Injectable()
export class NoopConversationEventsPublisher extends ConversationEventsPublisher {
  publishCreated(_event: ConversationCreatedEventRecord): Promise<void> {
    return Promise.resolve();
  }

  publishSettingsUpdated(
    _event: ConversationSettingsUpdatedEventRecord,
  ): Promise<void> {
    return Promise.resolve();
  }
}

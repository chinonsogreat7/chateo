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

interface GroupChangedEventRecordBase {
  conversationId: string;
  actorId: string;
  recipientIds: string[];
  occurredAt: Date;
}

export type GroupChangedEventRecord =
  | (GroupChangedEventRecordBase & {
      kind: 'metadata-updated';
      name: string;
      avatarUrl: string | null;
    })
  | (GroupChangedEventRecordBase & {
      kind: 'members-added';
      memberIds: string[];
    })
  | (GroupChangedEventRecordBase & {
      kind: 'member-removed';
      memberId: string;
      reason: 'removed' | 'left';
    })
  | (GroupChangedEventRecordBase & {
      kind: 'member-role-updated';
      memberId: string;
      role: 'ADMIN' | 'MEMBER';
    })
  | (GroupChangedEventRecordBase & {
      kind: 'ownership-transferred';
      previousOwnerId: string;
      newOwnerId: string;
    })
  | (GroupChangedEventRecordBase & {
      kind: 'deleted';
    });

export abstract class ConversationEventsPublisher {
  abstract publishCreated(event: ConversationCreatedEventRecord): Promise<void>;

  abstract publishSettingsUpdated(
    event: ConversationSettingsUpdatedEventRecord,
  ): Promise<void>;

  abstract publishGroupChanged(event: GroupChangedEventRecord): Promise<void>;
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

  publishGroupChanged(_event: GroupChangedEventRecord): Promise<void> {
    return Promise.resolve();
  }
}

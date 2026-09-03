export interface ConversationSettingsRecord {
  conversationId: string;
  archivedAt: Date | null;
  mutedAt: Date | null;
  pinnedAt: Date | null;
}

export type UpdateConversationSettingsResult =
  | {
      status: 'updated';
      changed: boolean;
      settings: ConversationSettingsRecord;
    }
  | { status: 'conversation-not-found' };

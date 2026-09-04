export interface ConversationSettingsRecord {
  conversationId: string;
  archivedAt: Date | null;
  mutedAt: Date | null;
  mutedUntil: Date | null;
  pinnedAt: Date | null;
  favoritedAt: Date | null;
  clearedAt: Date | null;
  clearedThroughMessageId: string | null;
}

export type UpdateConversationSettingsResult =
  | {
      status: 'updated';
      changed: boolean;
      settings: ConversationSettingsRecord;
    }
  | { status: 'conversation-not-found' };

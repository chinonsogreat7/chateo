import type { UpdateConversationSettingsResult } from './conversation-settings.types';

export interface UpdateConversationSettingsInput {
  conversationId: string;
  userId: string;
  archived?: boolean;
  muted?: boolean;
  /**
   * The mute expiry when `muted` is true. `null` (and omission for the
   * legacy PATCH endpoint) means the conversation stays muted indefinitely.
   */
  mutedUntil?: Date | null;
  pinned?: boolean;
  favorited?: boolean;
  now: Date;
}

export abstract class ConversationSettingsRepository {
  abstract updateForMember(
    input: UpdateConversationSettingsInput,
  ): Promise<UpdateConversationSettingsResult>;
}

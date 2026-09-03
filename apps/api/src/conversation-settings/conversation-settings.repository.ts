import type { UpdateConversationSettingsResult } from './conversation-settings.types';

export interface UpdateConversationSettingsInput {
  conversationId: string;
  userId: string;
  archived?: boolean;
  muted?: boolean;
  pinned?: boolean;
  now: Date;
}

export abstract class ConversationSettingsRepository {
  abstract updateForMember(
    input: UpdateConversationSettingsInput,
  ): Promise<UpdateConversationSettingsResult>;
}

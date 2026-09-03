import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationEventsPublisher } from '../conversations/conversation-events.publisher';
import { ConversationSettingsRepository } from './conversation-settings.repository';
import type { ConversationSettingsResponseDto } from './dto/conversation-settings-response.dto';
import type { UpdateConversationSettingsDto } from './dto/update-conversation-settings.dto';

@Injectable()
export class ConversationSettingsService {
  private readonly logger = new Logger(ConversationSettingsService.name);

  constructor(
    private readonly repository: ConversationSettingsRepository,
    private readonly clock: Clock,
    private readonly eventsPublisher: ConversationEventsPublisher,
  ) {}

  async update(
    userId: string,
    conversationId: string,
    input: UpdateConversationSettingsDto,
  ): Promise<ConversationSettingsResponseDto> {
    if (
      input.archived === undefined &&
      input.muted === undefined &&
      input.pinned === undefined
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONVERSATION_SETTINGS_UPDATE_EMPTY',
        'Provide at least one conversation setting to update.',
      );
    }

    const now = this.clock.now();
    const result = await this.repository.updateForMember({
      conversationId: conversationId.toLowerCase(),
      userId: userId.toLowerCase(),
      archived: input.archived,
      muted: input.muted,
      pinned: input.pinned,
      now,
    });
    if (result.status === 'conversation-not-found') {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'CONVERSATION_NOT_FOUND',
        'The conversation was not found.',
      );
    }

    const { settings } = result;
    const response = {
      conversationId: settings.conversationId,
      archived: settings.archivedAt !== null,
      muted: settings.mutedAt !== null,
      pinned: settings.pinnedAt !== null,
      archivedAt: settings.archivedAt?.toISOString() ?? null,
      mutedAt: settings.mutedAt?.toISOString() ?? null,
      pinnedAt: settings.pinnedAt?.toISOString() ?? null,
    };
    if (result.changed) {
      try {
        await this.eventsPublisher.publishSettingsUpdated({
          conversationId: settings.conversationId,
          userId: userId.toLowerCase(),
          archivedAt: settings.archivedAt,
          mutedAt: settings.mutedAt,
          pinnedAt: settings.pinnedAt,
          occurredAt: now,
        });
      } catch {
        this.logger.warn(
          `Failed to publish conversation.settings.updated for ${settings.conversationId}`,
        );
      }
    }
    return response;
  }
}

import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Clock } from '../auth/providers/clock';
import { ApiException } from '../common/errors/api.exception';
import { ConversationEventsPublisher } from '../conversations/conversation-events.publisher';
import {
  ConversationSettingsRepository,
  type UpdateConversationSettingsInput,
} from './conversation-settings.repository';
import type { ConversationSettingsResponseDto } from './dto/conversation-settings-response.dto';
import { ConversationMuteDuration } from './dto/mute-conversation.dto';
import type { UpdateConversationSettingsDto } from './dto/update-conversation-settings.dto';

const MUTE_DURATION_MILLISECONDS = {
  [ConversationMuteDuration.EightHours]: 8 * 60 * 60 * 1_000,
  [ConversationMuteDuration.TwentyFourHours]: 24 * 60 * 60 * 1_000,
  [ConversationMuteDuration.SevenDays]: 7 * 24 * 60 * 60 * 1_000,
} as const;

type SettingsMutation = Omit<
  UpdateConversationSettingsInput,
  'conversationId' | 'userId' | 'now'
>;

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

    return this.updateForMember(userId, conversationId, {
      archived: input.archived,
      muted: input.muted,
      mutedUntil: input.muted === true ? null : undefined,
      pinned: input.pinned,
    });
  }

  mute(
    userId: string,
    conversationId: string,
    duration: ConversationMuteDuration,
  ): Promise<ConversationSettingsResponseDto> {
    const now = this.clock.now();
    const mutedUntil =
      duration === ConversationMuteDuration.Always
        ? null
        : new Date(now.getTime() + MUTE_DURATION_MILLISECONDS[duration]);
    return this.updateForMember(
      userId,
      conversationId,
      { muted: true, mutedUntil },
      now,
    );
  }

  unmute(
    userId: string,
    conversationId: string,
  ): Promise<ConversationSettingsResponseDto> {
    return this.updateForMember(userId, conversationId, { muted: false });
  }

  setArchived(
    userId: string,
    conversationId: string,
    archived: boolean,
  ): Promise<ConversationSettingsResponseDto> {
    return this.updateForMember(userId, conversationId, { archived });
  }

  setFavorite(
    userId: string,
    conversationId: string,
    favorited: boolean,
  ): Promise<ConversationSettingsResponseDto> {
    return this.updateForMember(userId, conversationId, { favorited });
  }

  private async updateForMember(
    userId: string,
    conversationId: string,
    mutation: SettingsMutation,
    providedNow?: Date,
  ): Promise<ConversationSettingsResponseDto> {
    const now = providedNow ?? this.clock.now();
    const normalizedUserId = userId.toLowerCase();
    const result = await this.repository.updateForMember({
      conversationId: conversationId.toLowerCase(),
      userId: normalizedUserId,
      ...mutation,
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
      muted:
        settings.mutedAt !== null &&
        (settings.mutedUntil === null || settings.mutedUntil > now),
      pinned: settings.pinnedAt !== null,
      favorited: settings.favoritedAt !== null,
      archivedAt: settings.archivedAt?.toISOString() ?? null,
      mutedAt: settings.mutedAt?.toISOString() ?? null,
      mutedUntil: settings.mutedUntil?.toISOString() ?? null,
      pinnedAt: settings.pinnedAt?.toISOString() ?? null,
      favoritedAt: settings.favoritedAt?.toISOString() ?? null,
      clearedAt: settings.clearedAt?.toISOString() ?? null,
      clearedThroughMessageId: settings.clearedThroughMessageId,
    };
    if (result.changed) {
      this.publishSettingsUpdatedBestEffort(
        settings.conversationId,
        normalizedUserId,
        settings.archivedAt,
        settings.mutedAt,
        settings.mutedUntil,
        settings.pinnedAt,
        settings.favoritedAt,
        now,
      );
    }
    return response;
  }

  private publishSettingsUpdatedBestEffort(
    conversationId: string,
    userId: string,
    archivedAt: Date | null,
    mutedAt: Date | null,
    mutedUntil: Date | null,
    pinnedAt: Date | null,
    favoritedAt: Date | null,
    occurredAt: Date,
  ): void {
    try {
      void Promise.resolve(
        this.eventsPublisher.publishSettingsUpdated({
          conversationId,
          userId,
          archivedAt,
          mutedAt,
          mutedUntil,
          pinnedAt,
          favoritedAt,
          occurredAt,
        }),
      ).catch(() => {
        this.logger.warn(
          `Failed to publish conversation.settings.updated for ${conversationId}`,
        );
      });
    } catch {
      this.logger.warn(
        `Failed to publish conversation.settings.updated for ${conversationId}`,
      );
    }
  }
}

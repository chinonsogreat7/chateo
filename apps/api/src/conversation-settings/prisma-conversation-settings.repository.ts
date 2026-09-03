import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  ConversationSettingsRepository,
  type UpdateConversationSettingsInput,
} from './conversation-settings.repository';
import type {
  ConversationSettingsRecord,
  UpdateConversationSettingsResult,
} from './conversation-settings.types';

const settingsSelect = {
  conversationId: true,
  archivedAt: true,
  mutedAt: true,
  pinnedAt: true,
} satisfies Prisma.ConversationMemberSelect;

type SelectedSettings = Prisma.ConversationMemberGetPayload<{
  select: typeof settingsSelect;
}>;

interface SettingsUpdateData {
  archivedAt?: Date | null;
  mutedAt?: Date | null;
  pinnedAt?: Date | null;
}

@Injectable()
export class PrismaConversationSettingsRepository extends ConversationSettingsRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async updateForMember(
    input: UpdateConversationSettingsInput,
  ): Promise<UpdateConversationSettingsResult> {
    const normalizedInput: UpdateConversationSettingsInput = {
      ...input,
      conversationId: input.conversationId.toLowerCase(),
      userId: input.userId.toLowerCase(),
    };
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) =>
            this.updateInTransaction(transaction, normalizedInput),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        const retryable = this.prismaErrorCode(error) === 'P2034';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  private async updateInTransaction(
    transaction: Prisma.TransactionClient,
    input: UpdateConversationSettingsInput,
  ): Promise<UpdateConversationSettingsResult> {
    const where = {
      conversationId_userId: {
        conversationId: input.conversationId,
        userId: input.userId,
      },
    };
    const current = await transaction.conversationMember.findUnique({
      where,
      select: settingsSelect,
    });
    if (!current) return { status: 'conversation-not-found' };

    const data = this.updateData(current, input);
    if (Object.keys(data).length === 0) {
      return {
        status: 'updated',
        changed: false,
        settings: this.toRecord(current),
      };
    }

    try {
      const updated = await transaction.conversationMember.update({
        where,
        data,
        select: settingsSelect,
      });
      return {
        status: 'updated',
        changed: true,
        settings: this.toRecord(updated),
      };
    } catch (error) {
      if (this.prismaErrorCode(error) === 'P2025') {
        return { status: 'conversation-not-found' };
      }
      throw error;
    }
  }

  private updateData(
    current: SelectedSettings,
    input: UpdateConversationSettingsInput,
  ): SettingsUpdateData {
    const data: SettingsUpdateData = {};
    this.assignTimestamp(
      data,
      'archivedAt',
      input.archived,
      current.archivedAt,
      input.now,
    );
    this.assignTimestamp(
      data,
      'mutedAt',
      input.muted,
      current.mutedAt,
      input.now,
    );
    this.assignTimestamp(
      data,
      'pinnedAt',
      input.pinned,
      current.pinnedAt,
      input.now,
    );
    return data;
  }

  private assignTimestamp(
    data: SettingsUpdateData,
    key: keyof SettingsUpdateData,
    enabled: boolean | undefined,
    current: Date | null,
    now: Date,
  ): void {
    if (enabled === undefined) return;
    if (enabled) {
      if (current === null) data[key] = now;
      return;
    }
    if (current !== null) data[key] = null;
  }

  private toRecord(settings: SelectedSettings): ConversationSettingsRecord {
    return {
      conversationId: settings.conversationId,
      archivedAt: settings.archivedAt,
      mutedAt: settings.mutedAt,
      pinnedAt: settings.pinnedAt,
    };
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }
}

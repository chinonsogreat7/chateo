import { randomUUID } from 'node:crypto';
import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
} from '../../src/conversations/conversations.types';
import type { UpdateConversationSettingsInput } from '../../src/conversation-settings/conversation-settings.repository';
import type {
  ConversationSettingsRecord,
  UpdateConversationSettingsResult,
} from '../../src/conversation-settings/conversation-settings.types';
import type {
  ContactMatchRecord,
  MatchContactsRepositoryInput,
  PublicDiscoveryUserRecord,
  SearchUsersRepositoryInput,
} from '../../src/discovery/discovery.types';

interface SeedUser extends ContactMatchRecord {
  profileCompletedAt: Date | null;
}

interface StoredConversation {
  id: string;
  directUserOneId: string;
  directUserTwoId: string;
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function copyUser(user: SeedUser): SeedUser {
  return {
    ...user,
    createdAt: copyDate(user.createdAt),
    profileCompletedAt: user.profileCompletedAt
      ? copyDate(user.profileCompletedAt)
      : null,
  };
}

function copyNullableDate(value: Date | null): Date | null {
  return value ? copyDate(value) : null;
}

function copySettings(
  settings: ConversationSettingsRecord,
): ConversationSettingsRecord {
  return {
    ...settings,
    archivedAt: copyNullableDate(settings.archivedAt),
    mutedAt: copyNullableDate(settings.mutedAt),
    mutedUntil: copyNullableDate(settings.mutedUntil),
    pinnedAt: copyNullableDate(settings.pinnedAt),
    favoritedAt: copyNullableDate(settings.favoritedAt),
    clearedAt: copyNullableDate(settings.clearedAt),
  };
}

export class InMemoryDiscoveryConversationsRepository {
  private readonly users = new Map<string, SeedUser>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly conversationIdsByPair = new Map<string, string>();
  private readonly settingsByMember = new Map<
    string,
    ConversationSettingsRecord
  >();

  get conversationCount(): number {
    return this.conversations.size;
  }

  seedUser(user: SeedUser): void {
    if (this.users.has(user.id)) {
      throw new Error(`A user with id ${user.id} is already seeded.`);
    }
    this.users.set(user.id, copyUser(user));
  }

  async matchContacts(
    input: MatchContactsRepositoryInput,
  ): Promise<ContactMatchRecord[]> {
    const requested = new Set(input.phoneNumbers);
    return [...this.users.values()]
      .filter(
        (user) =>
          user.id !== input.currentUserId && requested.has(user.phoneNumber),
      )
      .map((user) => ({
        id: user.id,
        phoneNumber: user.phoneNumber,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: copyDate(user.createdAt),
      }));
  }

  async searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<PublicDiscoveryUserRecord[]> {
    return [...this.users.values()]
      .filter(
        (user) =>
          user.id !== input.currentUserId &&
          user.profileCompletedAt !== null &&
          user.displayName !== null &&
          user.displayName
            .toLocaleLowerCase('en')
            .includes(input.normalizedQuery),
      )
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .filter((user) => {
        if (!input.after) return true;
        const timeComparison =
          user.createdAt.getTime() - input.after.createdAt.getTime();
        return (
          timeComparison < 0 ||
          (timeComparison === 0 && user.id < input.after.id)
        );
      })
      .slice(0, input.take)
      .map((user) => ({
        id: user.id,
        displayName: user.displayName,
        avatarUrl: user.avatarUrl,
        createdAt: copyDate(user.createdAt),
      }));
  }

  async createOrGetDirect(
    userId: string,
    participantId: string,
    now: Date,
  ): Promise<CreateDirectConversationResult> {
    if (!this.users.has(participantId)) {
      return { status: 'participant-not-found' };
    }

    const [directUserOneId, directUserTwoId] =
      userId < participantId
        ? [userId, participantId]
        : [participantId, userId];
    const pair = `${directUserOneId}:${directUserTwoId}`;
    const existingId = this.conversationIdsByPair.get(pair);
    if (existingId) {
      const existing = this.conversations.get(existingId);
      if (!existing) throw new Error('Conversation index is inconsistent.');
      return {
        status: 'existing',
        conversation: this.toConversation(existing, userId),
      };
    }

    const conversation: StoredConversation = {
      id: randomUUID(),
      directUserOneId,
      directUserTwoId,
      lastActivityAt: copyDate(now),
      createdAt: copyDate(now),
      updatedAt: copyDate(now),
    };
    this.conversations.set(conversation.id, conversation);
    this.conversationIdsByPair.set(pair, conversation.id);
    this.settingsByMember.set(
      this.memberKey(conversation.id, directUserOneId),
      this.initialSettings(conversation.id),
    );
    this.settingsByMember.set(
      this.memberKey(conversation.id, directUserTwoId),
      this.initialSettings(conversation.id),
    );
    return {
      status: 'created',
      conversation: this.toConversation(conversation, userId),
    };
  }

  async listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
    archived = false,
  ): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          (conversation.directUserOneId === userId ||
            conversation.directUserTwoId === userId) &&
          (this.requiredSettings(conversation.id, userId).archivedAt !==
            null) ===
            archived,
      )
      .sort((left, right) => {
        const leftPinned =
          this.requiredSettings(left.id, userId).pinnedAt !== null;
        const rightPinned =
          this.requiredSettings(right.id, userId).pinnedAt !== null;
        return (
          Number(rightPinned) - Number(leftPinned) ||
          right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
          right.id.localeCompare(left.id)
        );
      })
      .filter((conversation) => {
        if (!cursor) return true;
        const pinned =
          this.requiredSettings(conversation.id, userId).pinnedAt !== null;
        if (cursor.pinned !== pinned) return cursor.pinned && !pinned;
        const timeComparison =
          conversation.lastActivityAt.getTime() -
          cursor.lastActivityAt.getTime();
        return (
          timeComparison < 0 ||
          (timeComparison === 0 && conversation.id < cursor.id)
        );
      })
      .slice(0, take)
      .map((conversation) => this.toConversation(conversation, userId));
  }

  async updateForMember(
    input: UpdateConversationSettingsInput,
  ): Promise<UpdateConversationSettingsResult> {
    const conversationId = input.conversationId.toLowerCase();
    const userId = input.userId.toLowerCase();
    const conversation = this.conversations.get(conversationId);
    if (
      !conversation ||
      (conversation.directUserOneId !== userId &&
        conversation.directUserTwoId !== userId)
    ) {
      return { status: 'conversation-not-found' };
    }

    const current = this.requiredSettings(conversationId, userId);
    const next = copySettings(current);
    if (input.archived !== undefined) {
      next.archivedAt = input.archived
        ? (next.archivedAt ?? copyDate(input.now))
        : null;
    }
    if (input.muted !== undefined) {
      next.mutedAt = input.muted ? copyDate(input.now) : null;
      next.mutedUntil = input.muted
        ? copyNullableDate(input.mutedUntil ?? null)
        : null;
    }
    if (input.pinned !== undefined) {
      next.pinnedAt = input.pinned
        ? (next.pinnedAt ?? copyDate(input.now))
        : null;
    }
    if (input.favorited !== undefined) {
      next.favoritedAt = input.favorited
        ? (next.favoritedAt ?? copyDate(input.now))
        : null;
    }

    const changed = !this.sameSettings(current, next);
    if (changed) {
      this.settingsByMember.set(this.memberKey(conversationId, userId), next);
    }
    return {
      status: 'updated',
      changed,
      settings: copySettings(changed ? next : current),
    };
  }

  async findForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationRecord | null> {
    const conversation = this.conversations.get(conversationId);
    if (
      !conversation ||
      (conversation.directUserOneId !== userId &&
        conversation.directUserTwoId !== userId)
    ) {
      return null;
    }
    return this.toConversation(conversation, userId);
  }

  private toConversation(
    conversation: StoredConversation,
    currentUserId: string,
  ): ConversationRecord {
    const otherUserId =
      conversation.directUserOneId === currentUserId
        ? conversation.directUserTwoId
        : conversation.directUserOneId;
    const otherUser = this.users.get(otherUserId);
    if (!otherUser) throw new Error('Conversation participant is missing.');

    return {
      id: conversation.id,
      type: 'DIRECT',
      otherParticipant: {
        id: otherUser.id,
        displayName: otherUser.displayName,
        avatarUrl: otherUser.avatarUrl,
      },
      latestMessage: null,
      unreadCount: 0,
      settings: copySettings(
        this.requiredSettings(conversation.id, currentUserId),
      ),
      lastActivityAt: copyDate(conversation.lastActivityAt),
      createdAt: copyDate(conversation.createdAt),
      updatedAt: copyDate(conversation.updatedAt),
    };
  }

  private memberKey(conversationId: string, userId: string): string {
    return `${conversationId.toLowerCase()}:${userId.toLowerCase()}`;
  }

  private initialSettings(conversationId: string): ConversationSettingsRecord {
    return {
      conversationId,
      archivedAt: null,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    };
  }

  private requiredSettings(
    conversationId: string,
    userId: string,
  ): ConversationSettingsRecord {
    const settings = this.settingsByMember.get(
      this.memberKey(conversationId, userId),
    );
    if (!settings) throw new Error('Conversation member settings are missing.');
    return settings;
  }

  private sameSettings(
    left: ConversationSettingsRecord,
    right: ConversationSettingsRecord,
  ): boolean {
    return (
      left.archivedAt?.getTime() === right.archivedAt?.getTime() &&
      left.mutedAt?.getTime() === right.mutedAt?.getTime() &&
      left.mutedUntil?.getTime() === right.mutedUntil?.getTime() &&
      left.pinnedAt?.getTime() === right.pinnedAt?.getTime() &&
      left.favoritedAt?.getTime() === right.favoritedAt?.getTime() &&
      left.clearedAt?.getTime() === right.clearedAt?.getTime() &&
      left.clearedThroughMessageId === right.clearedThroughMessageId
    );
  }
}

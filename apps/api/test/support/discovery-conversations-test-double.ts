import { randomUUID } from 'node:crypto';
import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
} from '../../src/conversations/conversations.types';
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

export class InMemoryDiscoveryConversationsRepository {
  private readonly users = new Map<string, SeedUser>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly conversationIdsByPair = new Map<string, string>();

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
    return {
      status: 'created',
      conversation: this.toConversation(conversation, userId),
    };
  }

  async listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
  ): Promise<ConversationRecord[]> {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          conversation.directUserOneId === userId ||
          conversation.directUserTwoId === userId,
      )
      .sort(
        (left, right) =>
          right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .filter((conversation) => {
        if (!cursor) return true;
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
      lastActivityAt: copyDate(conversation.lastActivityAt),
      createdAt: copyDate(conversation.createdAt),
      updatedAt: copyDate(conversation.updatedAt),
    };
  }
}

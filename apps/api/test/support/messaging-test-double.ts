import { randomUUID } from 'node:crypto';
import type {
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
} from '../../src/conversations/conversations.types';
import type { SendTextMessageInput } from '../../src/messages/messages.repository';
import type {
  ListMessagesResult,
  MarkConversationReadResult,
  MessagePageCursor,
  MessageRecord,
  SendTextMessageResult,
} from '../../src/messages/messages.types';

interface SeedMessagingUser {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

interface StoredConversation {
  id: string;
  memberIds: string[];
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredMemberState {
  unreadCount: number;
  lastReadAt: Date | null;
}

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function memberKey(conversationId: string, userId: string): string {
  return `${conversationId}:${userId}`;
}

function idempotencyKey(senderId: string, clientMessageId: string): string {
  return `${senderId}:${clientMessageId}`;
}

/**
 * A shared in-memory implementation of the messaging and conversation
 * repository contracts. It keeps the HTTP and Socket.IO E2E suite focused on
 * application behaviour without requiring PostgreSQL.
 */
export class InMemoryMessagingRepository {
  private readonly users = new Map<string, SeedMessagingUser>();
  private readonly conversations = new Map<string, StoredConversation>();
  private readonly messages = new Map<string, MessageRecord>();
  private readonly messageIdsByIdempotencyKey = new Map<string, string>();
  private readonly memberStates = new Map<string, StoredMemberState>();

  get messageCount(): number {
    return this.messages.size;
  }

  seedUser(user: SeedMessagingUser): void {
    const normalizedId = user.id.toLowerCase();
    if (this.users.has(normalizedId)) {
      throw new Error(`A user with id ${normalizedId} is already seeded.`);
    }
    this.users.set(normalizedId, { ...user, id: normalizedId });
  }

  seedDirectConversation(
    id: string,
    firstUserId: string,
    secondUserId: string,
    createdAt: Date,
  ): void {
    const normalizedId = id.toLowerCase();
    const memberIds = [firstUserId.toLowerCase(), secondUserId.toLowerCase()];
    if (this.conversations.has(normalizedId)) {
      throw new Error(
        `A conversation with id ${normalizedId} is already seeded.`,
      );
    }
    if (new Set(memberIds).size !== 2) {
      throw new Error('A direct conversation requires two distinct members.');
    }
    for (const memberId of memberIds) {
      if (!this.users.has(memberId)) {
        throw new Error(`Conversation member ${memberId} is not seeded.`);
      }
    }

    this.conversations.set(normalizedId, {
      id: normalizedId,
      memberIds,
      lastActivityAt: copyDate(createdAt),
      createdAt: copyDate(createdAt),
      updatedAt: copyDate(createdAt),
    });
    for (const memberId of memberIds) {
      this.memberStates.set(memberKey(normalizedId, memberId), {
        unreadCount: 0,
        lastReadAt: null,
      });
    }
  }

  async createOrGetDirect(
    userId: string,
    participantId: string,
    now: Date,
  ): Promise<CreateDirectConversationResult> {
    const normalizedUserId = userId.toLowerCase();
    const normalizedParticipantId = participantId.toLowerCase();
    if (!this.users.has(normalizedParticipantId)) {
      return { status: 'participant-not-found' };
    }

    const existing = [...this.conversations.values()].find(
      (conversation) =>
        conversation.memberIds.length === 2 &&
        conversation.memberIds.includes(normalizedUserId) &&
        conversation.memberIds.includes(normalizedParticipantId),
    );
    if (existing) {
      return {
        status: 'existing',
        conversation: this.toConversation(existing, normalizedUserId),
      };
    }

    const id = randomUUID();
    this.seedDirectConversation(
      id,
      normalizedUserId,
      normalizedParticipantId,
      now,
    );
    const conversation = this.conversations.get(id);
    if (!conversation) throw new Error('Seeded conversation is missing.');
    return {
      status: 'created',
      conversation: this.toConversation(conversation, normalizedUserId),
    };
  }

  async listForUser(
    userId: string,
    cursor: ConversationPageCursor | null,
    take: number,
  ): Promise<ConversationRecord[]> {
    const normalizedUserId = userId.toLowerCase();
    return [...this.conversations.values()]
      .filter((conversation) =>
        conversation.memberIds.includes(normalizedUserId),
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
      .map((conversation) =>
        this.toConversation(conversation, normalizedUserId),
      );
  }

  async findForUser(
    conversationId: string,
    userId: string,
  ): Promise<ConversationRecord | null> {
    const conversation = this.conversations.get(conversationId.toLowerCase());
    const normalizedUserId = userId.toLowerCase();
    return conversation?.memberIds.includes(normalizedUserId)
      ? this.toConversation(conversation, normalizedUserId)
      : null;
  }

  async sendText(input: SendTextMessageInput): Promise<SendTextMessageResult> {
    const conversationId = input.conversationId.toLowerCase();
    const senderId = input.senderId.toLowerCase();
    const clientMessageId = input.clientMessageId.toLowerCase();
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.memberIds.includes(senderId)) {
      return { status: 'conversation-not-found' };
    }

    const key = idempotencyKey(senderId, clientMessageId);
    const existingId = this.messageIdsByIdempotencyKey.get(key);
    if (existingId) {
      const existing = this.messages.get(existingId);
      if (!existing)
        throw new Error('Message idempotency index is inconsistent.');
      if (
        existing.conversationId !== conversationId ||
        existing.kind !== 'TEXT' ||
        existing.text !== input.text
      ) {
        return { status: 'idempotency-conflict' };
      }
      return { status: 'existing', message: this.copyMessage(existing) };
    }

    const message: MessageRecord = {
      id: randomUUID(),
      conversationId,
      senderId,
      clientMessageId,
      kind: 'TEXT',
      text: input.text,
      createdAt: copyDate(input.now),
      participantIds: [...conversation.memberIds],
    };
    this.messages.set(message.id, message);
    this.messageIdsByIdempotencyKey.set(key, message.id);
    if (input.now.getTime() > conversation.lastActivityAt.getTime()) {
      conversation.lastActivityAt = copyDate(input.now);
      conversation.updatedAt = copyDate(input.now);
    }
    for (const memberId of conversation.memberIds) {
      if (memberId === senderId) continue;
      const state = this.requiredMemberState(conversationId, memberId);
      state.unreadCount += 1;
    }

    return { status: 'created', message: this.copyMessage(message) };
  }

  async listForMember(
    conversationId: string,
    userId: string,
    cursor: MessagePageCursor | null,
    take: number,
  ): Promise<ListMessagesResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = this.conversations.get(normalizedConversationId);
    if (!conversation?.memberIds.includes(normalizedUserId)) {
      return { status: 'conversation-not-found' };
    }

    const messages = [...this.messages.values()]
      .filter((message) => message.conversationId === normalizedConversationId)
      .sort(
        (left, right) =>
          right.createdAt.getTime() - left.createdAt.getTime() ||
          right.id.localeCompare(left.id),
      )
      .filter((message) => {
        if (!cursor) return true;
        const timeComparison =
          message.createdAt.getTime() - cursor.createdAt.getTime();
        return (
          timeComparison < 0 || (timeComparison === 0 && message.id < cursor.id)
        );
      })
      .slice(0, take)
      .map((message) => this.copyMessage(message));
    return { status: 'found', messages };
  }

  async markRead(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<MarkConversationReadResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = this.conversations.get(normalizedConversationId);
    if (!conversation?.memberIds.includes(normalizedUserId)) {
      return { status: 'conversation-not-found' };
    }

    const state = this.requiredMemberState(
      normalizedConversationId,
      normalizedUserId,
    );
    const latestMessage = this.latestMessage(normalizedConversationId);
    const lastReadAt = [now, state.lastReadAt, latestMessage?.createdAt]
      .filter((value): value is Date => value !== null && value !== undefined)
      .reduce((latest, candidate) =>
        candidate.getTime() > latest.getTime() ? candidate : latest,
      );
    state.unreadCount = 0;
    state.lastReadAt = copyDate(lastReadAt);
    return {
      status: 'updated',
      state: {
        conversationId: normalizedConversationId,
        lastReadAt: copyDate(lastReadAt),
        unreadCount: 0,
      },
    };
  }

  private requiredMemberState(
    conversationId: string,
    userId: string,
  ): StoredMemberState {
    const state = this.memberStates.get(memberKey(conversationId, userId));
    if (!state) throw new Error('Conversation member state is missing.');
    return state;
  }

  private latestMessage(conversationId: string): MessageRecord | null {
    return (
      [...this.messages.values()]
        .filter((message) => message.conversationId === conversationId)
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() ||
            right.id.localeCompare(left.id),
        )[0] ?? null
    );
  }

  private toConversation(
    conversation: StoredConversation,
    currentUserId: string,
  ): ConversationRecord {
    const otherUserId = conversation.memberIds.find(
      (memberId) => memberId !== currentUserId,
    );
    const otherUser = otherUserId ? this.users.get(otherUserId) : undefined;
    if (!otherUser) throw new Error('Conversation participant is missing.');
    const latestMessage = this.latestMessage(conversation.id);
    const state = this.requiredMemberState(conversation.id, currentUserId);

    return {
      id: conversation.id,
      type: 'DIRECT',
      otherParticipant: { ...otherUser },
      latestMessage: latestMessage
        ? {
            id: latestMessage.id,
            senderId: latestMessage.senderId,
            kind: latestMessage.kind,
            text: latestMessage.text,
            createdAt: copyDate(latestMessage.createdAt),
          }
        : null,
      unreadCount: state.unreadCount,
      lastActivityAt: copyDate(conversation.lastActivityAt),
      createdAt: copyDate(conversation.createdAt),
      updatedAt: copyDate(conversation.updatedAt),
    };
  }

  private copyMessage(message: MessageRecord): MessageRecord {
    return {
      ...message,
      createdAt: copyDate(message.createdAt),
      participantIds: [...message.participantIds],
    };
  }
}

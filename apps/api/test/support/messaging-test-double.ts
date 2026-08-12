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
import type { RealtimeConversationAccess } from '../../src/realtime/realtime-conversations.repository';
import type { MarkReceiptThroughInput } from '../../src/receipts/receipts.repository';
import type {
  ListReceiptFrontiersResult,
  MarkReceiptResult,
  ReceiptFrontierRecord,
} from '../../src/receipts/receipts.types';

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
  receiptVersion: number;
}

interface StoredReceipt {
  messageId: string;
  conversationId: string;
  userId: string;
  deliveredAt: Date;
  readAt: Date | null;
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

function receiptKey(messageId: string, userId: string): string {
  return `${messageId}:${userId}`;
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
  private readonly receipts = new Map<string, StoredReceipt>();

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
        receiptVersion: 0,
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

  async findAccessibleConversation(
    conversationId: string,
    userId: string,
  ): Promise<RealtimeConversationAccess | null> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = this.conversations.get(normalizedConversationId);
    if (!conversation?.memberIds.includes(normalizedUserId)) return null;

    return {
      conversationId: conversation.id,
      participantIds: [...conversation.memberIds].sort(),
    };
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
  ): Promise<ListReceiptFrontiersResult>;
  async listForMember(
    conversationId: string,
    userId: string,
    cursor: MessagePageCursor | null,
    take: number,
  ): Promise<ListMessagesResult>;
  async listForMember(
    conversationId: string,
    userId: string,
    cursor?: MessagePageCursor | null,
    take?: number,
  ): Promise<ListMessagesResult | ListReceiptFrontiersResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = this.conversations.get(normalizedConversationId);
    if (!conversation?.memberIds.includes(normalizedUserId)) {
      return { status: 'conversation-not-found' };
    }

    if (take === undefined) {
      return this.listReceiptFrontiers(conversation);
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

  async markThrough(
    input: MarkReceiptThroughInput,
  ): Promise<MarkReceiptResult> {
    const conversationId = input.conversationId.toLowerCase();
    const userId = input.userId.toLowerCase();
    const throughMessageId = input.throughMessageId.toLowerCase();
    const conversation = this.conversations.get(conversationId);
    if (!conversation?.memberIds.includes(userId)) {
      return { status: 'conversation-not-found' };
    }

    const boundary = this.messages.get(throughMessageId);
    if (
      !boundary ||
      boundary.conversationId !== conversationId ||
      boundary.senderId === userId
    ) {
      return { status: 'conversation-not-found' };
    }

    const eligibleMessages = [...this.messages.values()]
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          message.senderId !== userId &&
          (message.createdAt.getTime() < boundary.createdAt.getTime() ||
            (message.createdAt.getTime() === boundary.createdAt.getTime() &&
              message.id <= boundary.id)),
      )
      .sort(
        (left, right) =>
          left.createdAt.getTime() - right.createdAt.getTime() ||
          left.id.localeCompare(right.id),
      );

    const previous = this.latestReceipt(
      conversationId,
      userId,
      input.status === 'READ',
    );
    for (const message of eligibleMessages) {
      const key = receiptKey(message.id, userId);
      const existing = this.receipts.get(key);
      if (!existing) {
        this.receipts.set(key, {
          messageId: message.id,
          conversationId,
          userId,
          deliveredAt: copyDate(input.now),
          readAt: input.status === 'READ' ? copyDate(input.now) : null,
        });
      } else if (input.status === 'READ' && !existing.readAt) {
        existing.readAt = copyDate(input.now);
      }
    }

    const effective = this.latestReceipt(
      conversationId,
      userId,
      input.status === 'READ',
    );
    if (!effective) {
      throw new Error('Receipt write completed without an effective boundary.');
    }
    const changed = this.receiptFrontierAdvanced(previous, effective);

    const state = this.requiredMemberState(conversationId, userId);
    if (changed) state.receiptVersion += 1;
    if (input.status === 'READ') {
      state.unreadCount = [...this.messages.values()].filter(
        (message) =>
          message.conversationId === conversationId &&
          message.senderId !== userId &&
          !this.receipts.get(receiptKey(message.id, userId))?.readAt,
      ).length;
      const readAt = effective.readAt;
      if (!readAt) throw new Error('Read receipt is missing its timestamp.');
      if (!state.lastReadAt || readAt > state.lastReadAt) {
        state.lastReadAt = copyDate(readAt);
      }
    }

    const at =
      input.status === 'READ' ? effective.readAt : effective.deliveredAt;
    if (!at) throw new Error('Receipt is missing its effective timestamp.');
    const delivered = this.latestReceipt(conversationId, userId, false);
    const read = this.latestReceipt(conversationId, userId, true);
    if (!delivered) throw new Error('Delivery receipt is missing.');
    return {
      status: 'updated',
      changed,
      receipt: {
        conversationId,
        userId,
        status: input.status,
        throughMessageId: effective.messageId,
        at: copyDate(at),
        version: state.receiptVersion,
        delivered: {
          messageId: delivered.messageId,
          at: copyDate(delivered.deliveredAt),
        },
        read: read?.readAt
          ? { messageId: read.messageId, at: copyDate(read.readAt) }
          : null,
        unreadCount: state.unreadCount,
        participantIds: [...conversation.memberIds],
      },
    };
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

  private latestReceipt(
    conversationId: string,
    userId: string,
    requireRead: boolean,
  ): StoredReceipt | null {
    return (
      [...this.receipts.values()]
        .filter(
          (receipt) =>
            receipt.conversationId === conversationId &&
            receipt.userId === userId &&
            (!requireRead || receipt.readAt !== null),
        )
        .sort((left, right) => {
          const leftMessage = this.messages.get(left.messageId);
          const rightMessage = this.messages.get(right.messageId);
          if (!leftMessage || !rightMessage) {
            throw new Error('Receipt points to a missing message.');
          }
          return (
            rightMessage.createdAt.getTime() -
              leftMessage.createdAt.getTime() ||
            right.messageId.localeCompare(left.messageId)
          );
        })[0] ?? null
    );
  }

  private listReceiptFrontiers(
    conversation: StoredConversation,
  ): ListReceiptFrontiersResult {
    const frontiers: ReceiptFrontierRecord[] = conversation.memberIds
      .slice()
      .sort()
      .map((userId) => {
        const memberState = this.requiredMemberState(conversation.id, userId);
        const delivered = this.latestReceipt(conversation.id, userId, false);
        const read = this.latestReceipt(conversation.id, userId, true);
        return {
          userId,
          version: memberState.receiptVersion,
          delivered: delivered
            ? {
                messageId: delivered.messageId,
                at: copyDate(delivered.deliveredAt),
              }
            : null,
          read: read?.readAt
            ? { messageId: read.messageId, at: copyDate(read.readAt) }
            : null,
        };
      });

    return {
      status: 'found',
      conversationId: conversation.id,
      frontiers,
    };
  }

  private receiptFrontierAdvanced(
    previous: StoredReceipt | null,
    effective: StoredReceipt,
  ): boolean {
    if (!previous) return true;
    const previousMessage = this.messages.get(previous.messageId);
    const effectiveMessage = this.messages.get(effective.messageId);
    if (!previousMessage || !effectiveMessage) {
      throw new Error('Receipt points to a missing message.');
    }
    const timeDifference =
      effectiveMessage.createdAt.getTime() -
      previousMessage.createdAt.getTime();
    return (
      timeDifference > 0 ||
      (timeDifference === 0 && effective.messageId > previous.messageId)
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

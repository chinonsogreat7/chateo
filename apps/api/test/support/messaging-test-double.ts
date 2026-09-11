import { randomUUID } from 'node:crypto';
import {
  documentFormat,
  mediaType,
  videoFormat,
} from '../../src/media/attachment-formats';
import { messageFingerprint } from '../../src/messages/message-mapping';
import type { MessagesRepository } from '../../src/messages/messages.repository';
import type {
  ConversationMemberRoleRecord,
  ConversationPageCursor,
  ConversationRecord,
  CreateDirectConversationResult,
} from '../../src/conversations/conversations.types';
import type {
  SendMessageInput,
  SendTextMessageInput,
} from '../../src/messages/messages.repository';
import type {
  ClearConversationMessagesResult,
  ListMessagesResult,
  MarkConversationReadResult,
  MessageAttachmentRecord,
  MessagePageCursor,
  MessageRecord,
  SendMessageResult,
  SendTextMessageResult,
  GetMessageResult,
  MutateMessageResult,
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

interface StoredConversationBase {
  id: string;
  memberIds: string[];
  lastActivityAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface StoredDirectConversation extends StoredConversationBase {
  type: 'DIRECT';
}

interface StoredGroupConversation extends StoredConversationBase {
  type: 'GROUP';
  name: string;
  avatarUrl: string | null;
  rolesByMemberId: Map<string, ConversationMemberRoleRecord>;
}

type StoredConversation = StoredDirectConversation | StoredGroupConversation;

interface SeedMessageAttachmentMedia {
  id: string;
  ownerId: string;
  purpose?: 'MESSAGE_ATTACHMENT' | 'PROFILE_AVATAR';
  status?: 'PENDING' | 'READY' | 'FAILED' | 'DELETED';
  resourceType?: 'image' | 'video' | 'raw';
  deliveryType?: 'upload' | 'authenticated';
  contentType?: string;
  format?: string;
  filename?: string;
  sizeBytes?: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  url?: string | null;
  deleted?: boolean;
  claimedMessageId?: string | null;
}

interface StoredMessageAttachmentMedia {
  id: string;
  ownerId: string;
  purpose: 'MESSAGE_ATTACHMENT' | 'PROFILE_AVATAR';
  status: 'PENDING' | 'READY' | 'FAILED' | 'DELETED';
  resourceType: 'image' | 'video' | 'raw';
  deliveryType: 'upload' | 'authenticated';
  contentType: string;
  format: string;
  filename: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  url: string | null;
  deleted: boolean;
  claimedMessageId: string | null;
}

interface StoredMemberState {
  unreadCount: number;
  lastReadAt: Date | null;
  receiptVersion: number;
  archivedAt: Date | null;
  mutedAt: Date | null;
  mutedUntil: Date | null;
  pinnedAt: Date | null;
  favoritedAt: Date | null;
  clearedAt: Date | null;
  clearedThroughMessageId: string | null;
}

export interface MessagingConversationPreferences {
  conversationId: string;
  archivedAt: Date | null;
  mutedAt: Date | null;
  mutedUntil: Date | null;
  pinnedAt: Date | null;
  favoritedAt: Date | null;
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

function copyNullableDate(value: Date | null): Date | null {
  return value ? copyDate(value) : null;
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

function isAfterClearBoundary(
  message: Pick<MessageRecord, 'createdAt' | 'id'>,
  state: Pick<StoredMemberState, 'clearedAt' | 'clearedThroughMessageId'>,
): boolean {
  if (!state.clearedAt || !state.clearedThroughMessageId) return true;
  const timeDifference =
    message.createdAt.getTime() - state.clearedAt.getTime();
  return (
    timeDifference > 0 ||
    (timeDifference === 0 && message.id > state.clearedThroughMessageId)
  );
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
  private readonly fingerprints = new Map<string, string>();
  private readonly messageIdsByIdempotencyKey = new Map<string, string>();
  private readonly memberStates = new Map<string, StoredMemberState>();
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly attachmentMedia = new Map<
    string,
    StoredMessageAttachmentMedia
  >();

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
      type: 'DIRECT',
      memberIds,
      lastActivityAt: copyDate(createdAt),
      createdAt: copyDate(createdAt),
      updatedAt: copyDate(createdAt),
    });
    this.seedMemberStates(normalizedId, memberIds);
  }

  seedGroupConversation(
    id: string,
    memberIds: string[],
    ownerId: string,
    createdAt: Date,
    name = 'Study Group',
    avatarUrl: string | null = null,
  ): void {
    const normalizedId = id.toLowerCase();
    const normalizedMemberIds = memberIds.map((memberId) =>
      memberId.toLowerCase(),
    );
    const normalizedOwnerId = ownerId.toLowerCase();
    if (this.conversations.has(normalizedId)) {
      throw new Error(
        `A conversation with id ${normalizedId} is already seeded.`,
      );
    }
    if (
      normalizedMemberIds.length < 2 ||
      new Set(normalizedMemberIds).size !== normalizedMemberIds.length ||
      !normalizedMemberIds.includes(normalizedOwnerId)
    ) {
      throw new Error('A group requires distinct members including its owner.');
    }
    for (const memberId of normalizedMemberIds) {
      if (!this.users.has(memberId)) {
        throw new Error(`Conversation member ${memberId} is not seeded.`);
      }
    }

    this.conversations.set(normalizedId, {
      id: normalizedId,
      type: 'GROUP',
      memberIds: normalizedMemberIds,
      name,
      avatarUrl,
      rolesByMemberId: new Map(
        normalizedMemberIds.map((memberId) => [
          memberId,
          memberId === normalizedOwnerId ? 'OWNER' : 'MEMBER',
        ]),
      ),
      lastActivityAt: copyDate(createdAt),
      createdAt: copyDate(createdAt),
      updatedAt: copyDate(createdAt),
    });
    this.seedMemberStates(normalizedId, normalizedMemberIds);
  }

  seedMessageAttachmentMedia(input: SeedMessageAttachmentMedia): void {
    const id = input.id.toLowerCase();
    if (this.attachmentMedia.has(id)) {
      throw new Error(`Attachment media ${id} is already seeded.`);
    }
    const resourceType = input.resourceType ?? 'image';
    const contentType =
      input.contentType ??
      (resourceType === 'video' ? 'audio/m4a' : 'image/jpeg');
    this.attachmentMedia.set(id, {
      id,
      ownerId: input.ownerId.toLowerCase(),
      purpose: input.purpose ?? 'MESSAGE_ATTACHMENT',
      status: input.status ?? 'READY',
      resourceType,
      deliveryType: input.deliveryType ?? 'upload',
      contentType,
      format: input.format ?? this.defaultFormat(contentType),
      filename:
        input.filename ?? `document.${documentFormat(contentType) ?? 'bin'}`,
      sizeBytes: input.sizeBytes ?? 120_000,
      width:
        input.width === undefined
          ? resourceType === 'image'
            ? 640
            : null
          : input.width,
      height:
        input.height === undefined
          ? resourceType === 'image'
            ? 480
            : null
          : input.height,
      durationMs:
        input.durationMs === undefined
          ? resourceType === 'video'
            ? 42_000
            : null
          : input.durationMs,
      url:
        input.url === undefined
          ? `https://res.cloudinary.com/classroom/${resourceType}/upload/${id}.${resourceType === 'video' ? 'm4a' : 'jpg'}`
          : input.url,
      deleted: input.deleted ?? false,
      claimedMessageId: input.claimedMessageId ?? null,
    });
  }

  applyConversationPreferences(
    userId: string,
    settings: MessagingConversationPreferences,
  ): void {
    const state = this.requiredMemberState(
      settings.conversationId.toLowerCase(),
      userId.toLowerCase(),
    );
    state.archivedAt = copyNullableDate(settings.archivedAt);
    state.mutedAt = copyNullableDate(settings.mutedAt);
    state.mutedUntil = copyNullableDate(settings.mutedUntil);
    state.pinnedAt = copyNullableDate(settings.pinnedAt);
    state.favoritedAt = copyNullableDate(settings.favoritedAt);
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
        conversation.type === 'DIRECT' &&
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
    archived = false,
    favoritedOnly = false,
  ): Promise<ConversationRecord[]> {
    const normalizedUserId = userId.toLowerCase();
    return [...this.conversations.values()]
      .filter((conversation) => {
        if (!conversation.memberIds.includes(normalizedUserId)) return false;
        const state = this.requiredMemberState(
          conversation.id,
          normalizedUserId,
        );
        return (
          (state.archivedAt !== null) === archived &&
          (!favoritedOnly || state.favoritedAt !== null)
        );
      })
      .sort((left, right) => {
        const leftPinned =
          this.requiredMemberState(left.id, normalizedUserId).pinnedAt !== null;
        const rightPinned =
          this.requiredMemberState(right.id, normalizedUserId).pinnedAt !==
          null;
        return (
          Number(rightPinned) - Number(leftPinned) ||
          right.lastActivityAt.getTime() - left.lastActivityAt.getTime() ||
          right.id.localeCompare(left.id)
        );
      })
      .filter((conversation) => {
        if (!cursor) return true;
        const pinned =
          this.requiredMemberState(conversation.id, normalizedUserId)
            .pinnedAt !== null;
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
    message?: { id: string; createdAt: Date },
  ): Promise<RealtimeConversationAccess | null> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const conversation = this.conversations.get(normalizedConversationId);
    if (!conversation?.memberIds.includes(normalizedUserId)) return null;

    return {
      conversationId: conversation.id,
      participantIds: [...conversation.memberIds]
        .filter(
          (id) =>
            !message ||
            isAfterClearBoundary(
              message,
              this.requiredMemberState(conversation.id, id),
            ),
        )
        .sort(),
    };
  }

  async sendText(input: SendTextMessageInput): Promise<SendTextMessageResult> {
    return this.send({ ...input, attachmentMediaIds: [] });
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const conversationId = input.conversationId.toLowerCase();
    const senderId = input.senderId.toLowerCase();
    const clientMessageId = input.clientMessageId.toLowerCase();
    const attachmentMediaIds = input.attachmentMediaIds.map((mediaId) =>
      mediaId.toLowerCase(),
    );
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
      if (this.fingerprints.get(existing.id) !== messageFingerprint(input)) {
        return { status: 'idempotency-conflict' };
      }
      return { status: 'existing', message: this.copyMessage(existing) };
    }

    if (input.text === null && attachmentMediaIds.length === 0) {
      return { status: 'idempotency-conflict' };
    }
    if (input.replyToMessageId) {
      const parent = this.messages.get(input.replyToMessageId);
      if (
        !parent ||
        parent.conversationId !== conversationId ||
        parent.deletedAt ||
        !isAfterClearBoundary(
          parent,
          this.requiredMemberState(conversationId, senderId),
        )
      )
        return { status: 'reply-unavailable' };
    }

    const media = attachmentMediaIds.map((mediaId) =>
      this.attachmentMedia.get(mediaId),
    );
    const attachmentType = this.homogeneousAttachmentType(media);
    if (
      new Set(attachmentMediaIds).size !== attachmentMediaIds.length ||
      attachmentType === null ||
      (['audio', 'video', 'document'].includes(attachmentType ?? '') &&
        attachmentMediaIds.length !== 1) ||
      media.some(
        (asset) => !asset || !this.isAvailableAttachment(asset, senderId),
      )
    ) {
      return { status: 'attachment-unavailable' };
    }

    const newestClearTime = conversation.memberIds.reduce(
      (latest, memberId) => {
        const clearedAt = this.requiredMemberState(
          conversationId,
          memberId,
        ).clearedAt;
        return clearedAt && (!latest || clearedAt > latest)
          ? clearedAt
          : latest;
      },
      null as Date | null,
    );
    const createdAt =
      newestClearTime && newestClearTime.getTime() >= input.now.getTime()
        ? new Date(newestClearTime.getTime() + 1)
        : input.now;
    const messageId = randomUUID();
    const attachments = media.map((asset): MessageAttachmentRecord => {
      if (!asset || !this.isAvailableAttachment(asset, senderId)) {
        throw new Error('Verified attachment media became unavailable.');
      }
      if (mediaType(asset.contentType) === 'document') {
        return {
          mediaId: asset.id,
          type: 'document',
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
          filename: asset.filename,
          url: (asset.url as string).replace(
            '/raw/upload/',
            '/raw/upload/fl_attachment/',
          ),
        };
      }
      if (mediaType(asset.contentType) === 'video') {
        return {
          mediaId: asset.id,
          type: 'video',
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
          width: asset.width as number,
          height: asset.height as number,
          durationMs: asset.durationMs as number,
          url: asset.url as string,
        };
      }
      if (asset.resourceType === 'video') {
        return {
          mediaId: asset.id,
          type: 'audio',
          contentType: asset.contentType,
          sizeBytes: asset.sizeBytes,
          durationMs: asset.durationMs as number,
          url: asset.url as string,
        };
      }
      return {
        mediaId: asset.id,
        type: 'image',
        contentType: asset.contentType,
        sizeBytes: asset.sizeBytes,
        width: asset.width as number,
        height: asset.height as number,
        url: asset.url as string,
      };
    });
    const message: MessageRecord = {
      id: messageId,
      conversationId,
      senderId,
      clientMessageId,
      kind:
        attachmentType === 'video'
          ? 'VIDEO'
          : attachmentType === 'document'
            ? 'DOCUMENT'
            : attachmentType === 'audio'
              ? 'AUDIO'
              : attachmentType === 'image'
                ? 'IMAGE'
                : 'TEXT',
      text: input.text,
      replyToMessageId: input.replyToMessageId ?? null,
      editedAt: null,
      deletedAt: null,
      version: 0,
      reactions: [],
      attachments,
      createdAt: copyDate(createdAt),
      participantIds: [...conversation.memberIds],
    };
    for (const asset of media) {
      if (asset) asset.claimedMessageId = messageId;
    }
    this.messages.set(message.id, message);
    this.fingerprints.set(message.id, messageFingerprint(input));
    this.messageIdsByIdempotencyKey.set(key, message.id);
    if (createdAt.getTime() > conversation.lastActivityAt.getTime()) {
      conversation.lastActivityAt = copyDate(createdAt);
      conversation.updatedAt = copyDate(createdAt);
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
    query?: string,
  ): Promise<ListMessagesResult>;
  async listForMember(
    conversationId: string,
    userId: string,
    cursor?: MessagePageCursor | null,
    take?: number,
    query?: string,
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

    const state = this.requiredMemberState(
      normalizedConversationId,
      normalizedUserId,
    );
    const messages = [...this.messages.values()]
      .filter(
        (message) =>
          message.conversationId === normalizedConversationId &&
          (query === undefined ||
            (!message.deletedAt &&
              Boolean(
                message.text?.toLowerCase().includes(query.toLowerCase()),
              ))) &&
          isAfterClearBoundary(message, state),
      )
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

  async getForMember(
    conversationId: string,
    userId: string,
    messageId: string,
  ): Promise<GetMessageResult> {
    const conversation = this.conversations.get(conversationId);
    const message = this.messages.get(messageId);
    if (
      !conversation?.memberIds.includes(userId) ||
      !message ||
      message.conversationId !== conversationId ||
      !isAfterClearBoundary(
        message,
        this.requiredMemberState(conversationId, userId),
      )
    )
      return { status: 'message-not-found' };
    return { status: 'found', message: this.copyMessage(message) };
  }

  async mutate(
    input: Parameters<MessagesRepository['mutate']>[0],
  ): Promise<MutateMessageResult> {
    const access = await this.getForMember(
      input.conversationId,
      input.actorId,
      input.messageId,
    );
    if (access.status !== 'found') return access;
    const message = this.messages.get(input.messageId)!;
    const mutation = input.mutation;
    if (mutation.kind !== 'reaction' && message.senderId !== input.actorId)
      return { status: 'forbidden' };
    if (message.deletedAt && mutation.kind !== 'delete')
      return { status: 'deleted' };
    const previous =
      message.reactions?.find((reaction) => reaction.userId === input.actorId)
        ?.emoji ?? null;
    const changed =
      mutation.kind === 'delete'
        ? !message.deletedAt
        : mutation.kind === 'edit'
          ? message.text !== mutation.text
          : previous !== mutation.emoji;
    if (mutation.kind === 'edit') {
      if (message.kind === 'TEXT' && !mutation.text)
        return { status: 'empty-text' };
      if (changed && (message.version ?? 0) !== mutation.expectedVersion)
        return { status: 'version-conflict' };
    }
    if (changed) {
      message.version = (message.version ?? 0) + 1;
      if (mutation.kind === 'delete') {
        message.text = null;
        message.deletedAt = input.now;
        message.reactions = [];
      }
      if (mutation.kind === 'edit') {
        message.text = mutation.text;
        message.editedAt = input.now;
      }
      if (mutation.kind === 'reaction') {
        message.reactions = (message.reactions ?? []).filter(
          (reaction) => reaction.userId !== input.actorId,
        );
        if (mutation.emoji)
          message.reactions.push({
            userId: input.actorId,
            emoji: mutation.emoji,
          });
        message.reactions.sort((a, b) => a.userId.localeCompare(b.userId));
      }
    }
    return {
      status: 'updated',
      changed,
      event: {
        kind:
          mutation.kind === 'delete'
            ? 'deleted'
            : mutation.kind === 'edit'
              ? 'updated'
              : 'reaction-updated',
        actorId: input.actorId,
        message: this.copyMessage(message),
        occurredAt: input.now,
      },
    };
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
    const state = this.requiredMemberState(conversationId, userId);
    if (
      !boundary ||
      boundary.conversationId !== conversationId ||
      boundary.senderId === userId ||
      !isAfterClearBoundary(boundary, state)
    ) {
      return { status: 'conversation-not-found' };
    }

    const eligibleMessages = [...this.messages.values()]
      .filter(
        (message) =>
          message.conversationId === conversationId &&
          message.senderId !== userId &&
          isAfterClearBoundary(message, state) &&
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

    if (changed) state.receiptVersion += 1;
    if (input.status === 'READ') {
      state.unreadCount = [...this.messages.values()].filter(
        (message) =>
          message.conversationId === conversationId &&
          message.senderId !== userId &&
          isAfterClearBoundary(message, state) &&
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
    const latestMessage = this.latestMessage(normalizedConversationId, state);
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

  async clearForMember(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<ClearConversationMessagesResult> {
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
    const changed = Boolean(
      latestMessage && isAfterClearBoundary(latestMessage, state),
    );
    if (latestMessage && changed) {
      state.clearedAt = copyDate(latestMessage.createdAt);
      state.clearedThroughMessageId = latestMessage.id;
    }
    state.unreadCount = 0;

    return {
      status: 'cleared',
      changed,
      conversationId: normalizedConversationId,
      userId: normalizedUserId,
      clearedAt: state.clearedAt ? copyDate(state.clearedAt) : null,
      clearedThroughMessageId: state.clearedThroughMessageId,
      occurredAt: copyDate(now),
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

  private seedMemberStates(conversationId: string, memberIds: string[]): void {
    for (const memberId of memberIds) {
      this.memberStates.set(memberKey(conversationId, memberId), {
        unreadCount: 0,
        lastReadAt: null,
        receiptVersion: 0,
        archivedAt: null,
        mutedAt: null,
        mutedUntil: null,
        pinnedAt: null,
        favoritedAt: null,
        clearedAt: null,
        clearedThroughMessageId: null,
      });
    }
  }

  private isAvailableAttachment(
    asset: StoredMessageAttachmentMedia,
    senderId: string,
  ): boolean {
    const common =
      asset.ownerId === senderId &&
      asset.purpose === 'MESSAGE_ATTACHMENT' &&
      asset.status === 'READY' &&
      asset.deliveryType === 'upload' &&
      asset.sizeBytes > 0 &&
      asset.url !== null &&
      asset.url.length > 0 &&
      !asset.deleted &&
      asset.claimedMessageId === null;
    if (!common) return false;

    if (videoFormat(asset.contentType))
      return (
        asset.resourceType === 'video' &&
        asset.format === videoFormat(asset.contentType) &&
        asset.sizeBytes <= 50 * 1024 * 1024 &&
        asset.width !== null &&
        asset.width > 0 &&
        asset.width <= 1920 &&
        asset.height !== null &&
        asset.height > 0 &&
        asset.height <= 1920 &&
        asset.durationMs !== null &&
        asset.durationMs > 0 &&
        asset.durationMs <= 300000
      );
    if (documentFormat(asset.contentType))
      return (
        asset.resourceType === 'raw' &&
        asset.format === documentFormat(asset.contentType) &&
        asset.sizeBytes <= 25 * 1024 * 1024 &&
        asset.width === null &&
        asset.height === null &&
        asset.durationMs === null
      );

    if (asset.resourceType === 'image') {
      return (
        ['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType) &&
        this.imageFormatMatchesContentType(asset.format, asset.contentType) &&
        asset.sizeBytes <= 5 * 1024 * 1024 &&
        asset.width !== null &&
        asset.width > 0 &&
        asset.height !== null &&
        asset.height > 0
      );
    }

    return (
      asset.resourceType === 'video' &&
      this.audioFormatMatchesContentType(asset.format, asset.contentType) &&
      asset.sizeBytes <= 20 * 1024 * 1024 &&
      asset.durationMs !== null &&
      asset.durationMs > 0 &&
      asset.durationMs <= 900_000
    );
  }

  private homogeneousAttachmentType(
    media: Array<StoredMessageAttachmentMedia | undefined>,
  ): 'image' | 'audio' | 'video' | 'document' | 'none' | null {
    if (media.length === 0) return 'none';
    const types = new Set(
      media.map((asset) => (asset ? mediaType(asset.contentType) : 'invalid')),
    );
    if (types.size !== 1 || types.has('invalid')) return null;
    return [...types][0] as 'image' | 'audio' | 'video' | 'document';
  }

  private defaultFormat(contentType: string): string {
    if (videoFormat(contentType) || documentFormat(contentType))
      return videoFormat(contentType) ?? documentFormat(contentType)!;
    switch (contentType) {
      case 'image/jpeg':
        return 'jpg';
      case 'image/png':
        return 'png';
      case 'image/webp':
        return 'webp';
      case 'audio/aac':
        return 'aac';
      case 'audio/mp4':
      case 'audio/m4a':
      case 'audio/x-m4a':
        return 'm4a';
      case 'audio/mpeg':
        return 'mp3';
      case 'audio/ogg':
        return 'ogg';
      case 'audio/wav':
      case 'audio/x-wav':
        return 'wav';
      default:
        return 'unknown';
    }
  }

  private imageFormatMatchesContentType(
    format: string,
    contentType: string,
  ): boolean {
    return (
      (contentType === 'image/jpeg' && ['jpg', 'jpeg'].includes(format)) ||
      (contentType === 'image/png' && format === 'png') ||
      (contentType === 'image/webp' && format === 'webp')
    );
  }

  private audioFormatMatchesContentType(
    format: string,
    contentType: string,
  ): boolean {
    return (
      (contentType === 'audio/aac' && format === 'aac') ||
      (['audio/mp4', 'audio/m4a', 'audio/x-m4a'].includes(contentType) &&
        format === 'm4a') ||
      (contentType === 'audio/mpeg' && format === 'mp3') ||
      (contentType === 'audio/ogg' && format === 'ogg') ||
      (['audio/wav', 'audio/x-wav'].includes(contentType) && format === 'wav')
    );
  }

  private sameOrderedIds(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  private latestMessage(
    conversationId: string,
    state?: Pick<StoredMemberState, 'clearedAt' | 'clearedThroughMessageId'>,
  ): MessageRecord | null {
    return (
      [...this.messages.values()]
        .filter(
          (message) =>
            message.conversationId === conversationId &&
            (!state || isAfterClearBoundary(message, state)),
        )
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
    const state = this.requiredMemberState(conversation.id, currentUserId);
    const latestMessage = this.latestMessage(conversation.id, state);
    const base = {
      id: conversation.id,
      latestMessage: latestMessage
        ? {
            id: latestMessage.id,
            senderId: latestMessage.senderId,
            kind: latestMessage.kind,
            text: latestMessage.text,
            deletedAt: latestMessage.deletedAt,
            createdAt: copyDate(latestMessage.createdAt),
          }
        : null,
      unreadCount: state.unreadCount,
      settings: {
        archivedAt: copyNullableDate(state.archivedAt),
        mutedAt: copyNullableDate(state.mutedAt),
        mutedUntil: copyNullableDate(state.mutedUntil),
        pinnedAt: copyNullableDate(state.pinnedAt),
        favoritedAt: copyNullableDate(state.favoritedAt),
        clearedAt: copyNullableDate(state.clearedAt),
        clearedThroughMessageId: state.clearedThroughMessageId,
      },
      lastActivityAt: copyDate(conversation.lastActivityAt),
      createdAt: copyDate(conversation.createdAt),
      updatedAt: copyDate(conversation.updatedAt),
    };

    if (conversation.type === 'GROUP') {
      const participants = conversation.memberIds.map((memberId) => {
        const participant = this.users.get(memberId);
        const role = conversation.rolesByMemberId.get(memberId);
        if (!participant || !role) {
          throw new Error('Group participant state is inconsistent.');
        }
        return { ...participant, role };
      });
      const role = conversation.rolesByMemberId.get(currentUserId);
      if (!role) throw new Error('Current group member role is missing.');
      return {
        ...base,
        type: 'GROUP',
        name: conversation.name,
        avatarUrl: conversation.avatarUrl,
        participants,
        role,
      };
    }

    const otherUserId = conversation.memberIds.find(
      (memberId) => memberId !== currentUserId,
    );
    const otherUser = otherUserId ? this.users.get(otherUserId) : undefined;
    if (!otherUser) throw new Error('Conversation participant is missing.');
    return {
      ...base,
      type: 'DIRECT',
      otherParticipant: { ...otherUser },
    };
  }

  private copyMessage(message: MessageRecord): MessageRecord {
    return {
      ...message,
      attachments: message.deletedAt
        ? []
        : message.attachments.map((attachment) => ({ ...attachment })),
      reactions: (message.reactions ?? []).map((reaction) => ({ ...reaction })),
      createdAt: copyDate(message.createdAt),
      participantIds: [...message.participantIds],
    };
  }
}

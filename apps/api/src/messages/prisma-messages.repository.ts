import { Injectable } from '@nestjs/common';
import { MediaPurpose, MediaStatus, MessageKind, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import {
  MessagesRepository,
  type SendMessageInput,
} from './messages.repository';
import type {
  ClearConversationMessagesResult,
  ListMessagesResult,
  MarkConversationReadResult,
  MessageAttachmentRecord,
  MessagePageCursor,
  MessageRecord,
  SendMessageResult,
} from './messages.types';

const IMAGE_ATTACHMENT_FORMATS = ['jpg', 'jpeg', 'png', 'webp'] as const;
const IMAGE_ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
const MAX_AUDIO_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_ATTACHMENT_DURATION_MS = 900_000;
const AUDIO_ATTACHMENT_FORMAT_BY_MIME_TYPE: Readonly<Record<string, string>> = {
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

type AttachmentMessageKind = Extract<MessageKind, 'IMAGE' | 'AUDIO'>;

interface AttachmentMetadata {
  resourceType: string;
  deliveryType: string;
  format: string | null;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  secureUrl: string | null;
}

const messageSelect = {
  id: true,
  conversationId: true,
  senderId: true,
  clientMessageId: true,
  kind: true,
  text: true,
  createdAt: true,
  attachments: {
    orderBy: { position: 'asc' as const },
    select: {
      mediaAssetId: true,
      position: true,
      mediaAsset: {
        select: {
          resourceType: true,
          deliveryType: true,
          format: true,
          mimeType: true,
          byteSize: true,
          width: true,
          height: true,
          durationMs: true,
          secureUrl: true,
        },
      },
    },
  },
} satisfies Prisma.MessageSelect;

type SelectedMessage = Prisma.MessageGetPayload<{
  select: typeof messageSelect;
}>;

const attachmentAssetSelect = {
  id: true,
  cloudinaryAssetId: true,
  resourceType: true,
  deliveryType: true,
  format: true,
  mimeType: true,
  byteSize: true,
  width: true,
  height: true,
  durationMs: true,
  secureUrl: true,
  completedAt: true,
  messageClaimedAt: true,
  deletedAt: true,
} satisfies Prisma.MediaAssetSelect;

type SelectedAttachmentAsset = Prisma.MediaAssetGetPayload<{
  select: typeof attachmentAssetSelect;
}>;

class AttachmentClaimUnavailableError extends Error {
  constructor() {
    super('One or more message attachments could not be claimed.');
    this.name = AttachmentClaimUnavailableError.name;
  }
}

@Injectable()
export class PrismaMessagesRepository extends MessagesRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async send(input: SendMessageInput): Promise<SendMessageResult> {
    const normalizedInput: SendMessageInput = {
      ...input,
      conversationId: input.conversationId.toLowerCase(),
      senderId: input.senderId.toLowerCase(),
      clientMessageId: input.clientMessageId.toLowerCase(),
      attachmentMediaIds: input.attachmentMediaIds.map((mediaId) =>
        mediaId.toLowerCase(),
      ),
    };
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) =>
            this.sendInTransaction(transaction, normalizedInput),
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        lastError = error;
        if (error instanceof AttachmentClaimUnavailableError) {
          return { status: 'attachment-unavailable' };
        }
        const code = this.prismaErrorCode(error);

        if (code === 'P2002' || code === 'P2003') {
          const winner = await this.readConcurrentWinner(normalizedInput);
          if (winner) return winner;
          if (
            normalizedInput.attachmentMediaIds.length > 0 &&
            !(await this.attachmentsAvailable(
              this.prisma,
              normalizedInput.senderId,
              normalizedInput.attachmentMediaIds,
            ))
          ) {
            return { status: 'attachment-unavailable' };
          }
        }

        const retryable = code === 'P2034' || code === 'P2002';
        if (!retryable || attempt === maxAttempts) throw error;
      }
    }

    throw lastError;
  }

  async listForMember(
    conversationId: string,
    userId: string,
    cursor: MessagePageCursor | null,
    take: number,
  ): Promise<ListMessagesResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    return this.prisma.$transaction(
      async (transaction) => {
        const members = await transaction.conversationMember.findMany({
          where: { conversationId: normalizedConversationId },
          select: {
            userId: true,
            clearedAt: true,
            clearedThroughMessageId: true,
          },
        });
        const membership = members.find(
          (member) => member.userId === normalizedUserId,
        );
        if (!membership) {
          return { status: 'conversation-not-found' } as const;
        }

        const messages = await transaction.message.findMany({
          where: {
            conversationId: normalizedConversationId,
            AND: [
              ...(membership.clearedAt && membership.clearedThroughMessageId
                ? [
                    {
                      OR: [
                        { createdAt: { gt: membership.clearedAt } },
                        {
                          createdAt: membership.clearedAt,
                          id: { gt: membership.clearedThroughMessageId },
                        },
                      ],
                    },
                  ]
                : []),
              ...(cursor
                ? [
                    {
                      OR: [
                        { createdAt: { lt: cursor.createdAt } },
                        {
                          createdAt: cursor.createdAt,
                          id: { lt: cursor.id },
                        },
                      ],
                    },
                  ]
                : []),
            ],
          },
          select: messageSelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take,
        });
        const participantIds = this.uniqueUserIds(members);

        return {
          status: 'found',
          messages: messages.map((message) =>
            this.mapMessage(message, participantIds),
          ),
        } as const;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async markRead(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<MarkConversationReadResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();

    const maxAttempts = 3;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const membership = await transaction.conversationMember.findUnique({
              where: {
                conversationId_userId: {
                  conversationId: normalizedConversationId,
                  userId: normalizedUserId,
                },
              },
              select: { conversationId: true, lastReadAt: true },
            });
            if (!membership) {
              return { status: 'conversation-not-found' } as const;
            }

            const latestMessage = await transaction.message.findFirst({
              where: { conversationId: normalizedConversationId },
              select: { createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });
            const readBoundary = this.latestDate(
              now,
              membership.lastReadAt,
              latestMessage?.createdAt,
            );
            const updated = await transaction.conversationMember.update({
              where: {
                conversationId_userId: {
                  conversationId: normalizedConversationId,
                  userId: normalizedUserId,
                },
              },
              data: { unreadCount: 0, lastReadAt: readBoundary },
              select: {
                conversationId: true,
                lastReadAt: true,
                unreadCount: true,
              },
            });
            if (!updated.lastReadAt) {
              throw new Error('Updated read state is missing its timestamp.');
            }

            return {
              status: 'updated',
              state: {
                conversationId: updated.conversationId,
                lastReadAt: updated.lastReadAt,
                unreadCount: updated.unreadCount,
              },
            } as const;
          },
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

  async clearForMember(
    conversationId: string,
    userId: string,
    now: Date,
  ): Promise<ClearConversationMessagesResult> {
    const normalizedConversationId = conversationId.toLowerCase();
    const normalizedUserId = userId.toLowerCase();
    const maxAttempts = 3;
    let lastError: unknown;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (transaction) => {
            const membership = await transaction.conversationMember.findUnique({
              where: {
                conversationId_userId: {
                  conversationId: normalizedConversationId,
                  userId: normalizedUserId,
                },
              },
              select: {
                clearedAt: true,
                clearedThroughMessageId: true,
                unreadCount: true,
              },
            });
            if (!membership) {
              return { status: 'conversation-not-found' } as const;
            }

            const latestMessage = await transaction.message.findFirst({
              where: { conversationId: normalizedConversationId },
              select: { id: true, createdAt: true },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            });
            const boundaryAdvanced =
              latestMessage !== null &&
              this.isAfterBoundary(
                latestMessage.createdAt,
                latestMessage.id,
                membership.clearedAt,
                membership.clearedThroughMessageId,
              );
            const changed = boundaryAdvanced || membership.unreadCount !== 0;

            if (changed) {
              try {
                await transaction.conversationMember.update({
                  where: {
                    conversationId_userId: {
                      conversationId: normalizedConversationId,
                      userId: normalizedUserId,
                    },
                  },
                  data: {
                    unreadCount: 0,
                    ...(boundaryAdvanced && latestMessage
                      ? {
                          clearedAt: latestMessage.createdAt,
                          clearedThroughMessageId: latestMessage.id,
                        }
                      : {}),
                  },
                });
              } catch (error) {
                if (this.prismaErrorCode(error) === 'P2025') {
                  return { status: 'conversation-not-found' } as const;
                }
                throw error;
              }
            }

            const clearedAt = boundaryAdvanced
              ? (latestMessage?.createdAt ?? null)
              : membership.clearedAt;
            const clearedThroughMessageId = boundaryAdvanced
              ? (latestMessage?.id ?? null)
              : membership.clearedThroughMessageId;

            return {
              status: 'cleared',
              conversationId: normalizedConversationId,
              userId: normalizedUserId,
              changed,
              clearedAt,
              clearedThroughMessageId,
              occurredAt: now,
            } as const;
          },
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

  private async sendInTransaction(
    transaction: Prisma.TransactionClient,
    input: SendMessageInput,
  ): Promise<SendMessageResult> {
    const conversation = await transaction.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        type: true,
        members: { select: { userId: true, clearedAt: true } },
      },
    });
    const members = conversation?.members ?? [];
    if (!members.some((member) => member.userId === input.senderId)) {
      return { status: 'conversation-not-found' };
    }
    const participantIds = this.uniqueUserIds(members);

    // Idempotency describes the already-committed request, so a later block
    // must not change a safe retry from success (or conflict) into a 404.
    const existing = await transaction.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
        },
      },
      select: messageSelect,
    });
    if (existing) {
      return this.resolveExisting(existing, input, participantIds);
    }

    if (
      conversation?.type === 'DIRECT' &&
      (await this.hasBlockBetweenDirectParticipants(
        transaction,
        input.senderId,
        members,
      ))
    ) {
      return { status: 'conversation-not-found' };
    }

    const newestClearTimestamp = members.reduce<Date | null>(
      (latest, member) =>
        member.clearedAt &&
        (!latest || member.clearedAt.getTime() > latest.getTime())
          ? member.clearedAt
          : latest,
      null,
    );
    const messageCreatedAt =
      newestClearTimestamp &&
      newestClearTimestamp.getTime() >= input.now.getTime()
        ? new Date(newestClearTimestamp.getTime() + 1)
        : input.now;

    let messageKind: MessageKind = MessageKind.TEXT;
    if (input.attachmentMediaIds.length > 0) {
      const attachmentKind = await this.determineAttachmentKind(
        transaction,
        input.senderId,
        input.attachmentMediaIds,
      );
      if (!attachmentKind) {
        throw new AttachmentClaimUnavailableError();
      }
      messageKind = attachmentKind;

      const claimed = await transaction.mediaAsset.updateMany({
        where: this.availableAttachmentsWhere(
          input.senderId,
          input.attachmentMediaIds,
          attachmentKind,
        ),
        data: { messageClaimedAt: messageCreatedAt },
      });
      if (claimed.count !== input.attachmentMediaIds.length) {
        // Throwing (instead of returning) is intentional: Prisma must roll the
        // transaction back if updateMany claimed only part of the requested set.
        throw new AttachmentClaimUnavailableError();
      }
    }

    const message = await transaction.message.create({
      data: {
        conversationId: input.conversationId,
        senderId: input.senderId,
        clientMessageId: input.clientMessageId,
        kind: messageKind,
        text: input.text,
        createdAt: messageCreatedAt,
        ...(input.attachmentMediaIds.length > 0
          ? {
              attachments: {
                create: input.attachmentMediaIds.map(
                  (mediaAssetId, position) => ({ mediaAssetId, position }),
                ),
              },
            }
          : {}),
      },
      select: messageSelect,
    });
    await transaction.conversation.updateMany({
      where: {
        id: input.conversationId,
        lastActivityAt: { lt: messageCreatedAt },
      },
      data: {
        lastActivityAt: messageCreatedAt,
        updatedAt: messageCreatedAt,
      },
    });
    await transaction.conversationMember.updateMany({
      where: {
        conversationId: input.conversationId,
        userId: { not: input.senderId },
      },
      data: { unreadCount: { increment: 1 } },
    });

    return {
      status: 'created',
      message: this.mapMessage(message, participantIds),
    };
  }

  private async readConcurrentWinner(
    input: SendMessageInput,
  ): Promise<SendMessageResult | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: {
        type: true,
        members: { select: { userId: true } },
      },
    });
    const members = conversation?.members ?? [];
    if (!members.some((member) => member.userId === input.senderId)) {
      return { status: 'conversation-not-found' };
    }

    const winner = await this.prisma.message.findUnique({
      where: {
        senderId_clientMessageId: {
          senderId: input.senderId,
          clientMessageId: input.clientMessageId,
        },
      },
      select: messageSelect,
    });
    if (winner) {
      return this.resolveExisting(winner, input, this.uniqueUserIds(members));
    }

    return null;
  }

  private resolveExisting(
    message: SelectedMessage,
    input: SendMessageInput,
    participantIds: string[],
  ): SendMessageResult {
    const kindMatchesRequest =
      input.attachmentMediaIds.length === 0
        ? message.kind === MessageKind.TEXT
        : message.kind === MessageKind.IMAGE ||
          message.kind === MessageKind.AUDIO;
    if (
      message.conversationId !== input.conversationId ||
      !kindMatchesRequest ||
      message.text !== input.text ||
      !this.sameOrderedIds(
        message.attachments.map((attachment) => attachment.mediaAssetId),
        input.attachmentMediaIds,
      )
    ) {
      return { status: 'idempotency-conflict' };
    }
    return {
      status: 'existing',
      message: this.mapMessage(message, participantIds),
    };
  }

  private mapMessage(
    message: SelectedMessage,
    participantIds: string[],
  ): MessageRecord {
    if (
      (message.kind === MessageKind.TEXT && message.attachments.length !== 0) ||
      (message.kind === MessageKind.IMAGE &&
        message.attachments.length === 0) ||
      (message.kind === MessageKind.AUDIO && message.attachments.length !== 1)
    ) {
      throw new Error('Persisted message attachment count is invalid.');
    }

    return {
      id: message.id,
      conversationId: message.conversationId,
      clientMessageId: message.clientMessageId,
      senderId: message.senderId,
      kind: message.kind,
      text: message.text,
      attachments: message.attachments.map((attachment) =>
        this.mapAttachment(message.kind, attachment),
      ),
      createdAt: message.createdAt,
      participantIds,
    };
  }

  private sameOrderedIds(left: string[], right: string[]): boolean {
    return (
      left.length === right.length &&
      left.every((value, index) => value === right[index])
    );
  }

  private async attachmentsAvailable(
    client: Pick<Prisma.TransactionClient, 'mediaAsset'>,
    senderId: string,
    mediaIds: string[],
  ): Promise<boolean> {
    return (
      (await this.determineAttachmentKind(client, senderId, mediaIds)) !== null
    );
  }

  private availableAttachmentsWhere(
    senderId: string,
    mediaIds: string[],
    kind: AttachmentMessageKind,
  ): Prisma.MediaAssetWhereInput {
    return {
      id: { in: mediaIds },
      ownerId: senderId,
      purpose: MediaPurpose.MESSAGE_ATTACHMENT,
      status: MediaStatus.READY,
      deliveryType: 'upload',
      cloudinaryAssetId: { not: null },
      secureUrl: { not: null },
      completedAt: { not: null },
      messageClaimedAt: null,
      deletedAt: null,
      messageAttachments: { none: {} },
      ...(kind === MessageKind.IMAGE
        ? {
            resourceType: 'image',
            format: { in: [...IMAGE_ATTACHMENT_FORMATS] },
            mimeType: { in: [...IMAGE_ATTACHMENT_MIME_TYPES] },
            byteSize: { gt: 0 },
            width: { gt: 0 },
            height: { gt: 0 },
          }
        : {
            resourceType: 'video',
            byteSize: { gt: 0, lte: MAX_AUDIO_ATTACHMENT_BYTES },
            width: null,
            height: null,
            durationMs: {
              gt: 0,
              lte: MAX_AUDIO_ATTACHMENT_DURATION_MS,
            },
            OR: Object.entries(AUDIO_ATTACHMENT_FORMAT_BY_MIME_TYPE).map(
              ([mimeType, format]) => ({ mimeType, format }),
            ),
          }),
    };
  }

  private async determineAttachmentKind(
    client: Pick<Prisma.TransactionClient, 'mediaAsset'>,
    senderId: string,
    mediaIds: string[],
  ): Promise<AttachmentMessageKind | null> {
    if (
      mediaIds.length === 0 ||
      mediaIds.length > 10 ||
      new Set(mediaIds).size !== mediaIds.length
    ) {
      return null;
    }

    const assets = await client.mediaAsset.findMany({
      where: {
        id: { in: mediaIds },
        ownerId: senderId,
        purpose: MediaPurpose.MESSAGE_ATTACHMENT,
        status: MediaStatus.READY,
        deliveryType: 'upload',
        cloudinaryAssetId: { not: null },
        byteSize: { gt: 0 },
        secureUrl: { not: null },
        completedAt: { not: null },
        messageClaimedAt: null,
        deletedAt: null,
        messageAttachments: { none: {} },
      },
      select: attachmentAssetSelect,
    });
    if (assets.length !== mediaIds.length) return null;

    const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
    const orderedAssets = mediaIds.map((mediaId) => assetsById.get(mediaId));
    if (orderedAssets.some((asset) => asset === undefined)) return null;
    const verifiedAssets = orderedAssets as SelectedAttachmentAsset[];

    if (verifiedAssets.every((asset) => this.isValidImageAsset(asset))) {
      return MessageKind.IMAGE;
    }
    if (
      verifiedAssets.length === 1 &&
      this.isValidAudioAsset(verifiedAssets[0]!)
    ) {
      return MessageKind.AUDIO;
    }
    return null;
  }

  private mapAttachment(
    kind: MessageKind,
    attachment: SelectedMessage['attachments'][number],
  ): MessageAttachmentRecord {
    const media = attachment.mediaAsset;
    if (kind === MessageKind.IMAGE && this.isValidImageMetadata(media)) {
      return {
        mediaId: attachment.mediaAssetId,
        type: 'image',
        contentType: media.mimeType,
        sizeBytes: media.byteSize,
        width: media.width,
        height: media.height,
        url: media.secureUrl,
      };
    }
    if (kind === MessageKind.AUDIO && this.isValidAudioMetadata(media)) {
      return {
        mediaId: attachment.mediaAssetId,
        type: 'audio',
        contentType: media.mimeType,
        sizeBytes: media.byteSize,
        durationMs: media.durationMs,
        url: media.secureUrl,
      };
    }
    throw new Error('Persisted message attachment metadata is invalid.');
  }

  private isValidImageAsset(asset: SelectedAttachmentAsset): boolean {
    return (
      this.isCommonAvailableAsset(asset) && this.isValidImageMetadata(asset)
    );
  }

  private isValidAudioAsset(asset: SelectedAttachmentAsset): boolean {
    return (
      this.isCommonAvailableAsset(asset) && this.isValidAudioMetadata(asset)
    );
  }

  private isCommonAvailableAsset(asset: SelectedAttachmentAsset): boolean {
    return (
      Boolean(asset.cloudinaryAssetId) &&
      asset.deliveryType === 'upload' &&
      asset.byteSize > 0 &&
      this.isHttpsUrl(asset.secureUrl) &&
      asset.completedAt !== null &&
      asset.messageClaimedAt === null &&
      asset.deletedAt === null
    );
  }

  private isValidImageMetadata(
    media: AttachmentMetadata,
  ): media is AttachmentMetadata & {
    width: number;
    height: number;
    secureUrl: string;
  } {
    return (
      media.resourceType === 'image' &&
      media.deliveryType === 'upload' &&
      media.format !== null &&
      IMAGE_ATTACHMENT_FORMATS.includes(
        media.format as (typeof IMAGE_ATTACHMENT_FORMATS)[number],
      ) &&
      IMAGE_ATTACHMENT_MIME_TYPES.includes(
        media.mimeType as (typeof IMAGE_ATTACHMENT_MIME_TYPES)[number],
      ) &&
      media.byteSize > 0 &&
      media.width !== null &&
      media.width > 0 &&
      media.height !== null &&
      media.height > 0 &&
      this.isHttpsUrl(media.secureUrl)
    );
  }

  private isValidAudioMetadata(
    media: AttachmentMetadata,
  ): media is AttachmentMetadata & {
    durationMs: number;
    secureUrl: string;
  } {
    return (
      media.resourceType === 'video' &&
      media.deliveryType === 'upload' &&
      media.format !== null &&
      AUDIO_ATTACHMENT_FORMAT_BY_MIME_TYPE[media.mimeType] === media.format &&
      media.byteSize > 0 &&
      media.byteSize <= MAX_AUDIO_ATTACHMENT_BYTES &&
      media.width === null &&
      media.height === null &&
      media.durationMs !== null &&
      media.durationMs > 0 &&
      media.durationMs <= MAX_AUDIO_ATTACHMENT_DURATION_MS &&
      this.isHttpsUrl(media.secureUrl)
    );
  }

  private isHttpsUrl(value: string | null): value is string {
    if (!value) return false;
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private uniqueUserIds(members: Array<{ userId: string }>): string[] {
    return [...new Set(members.map((member) => member.userId))];
  }

  private async hasBlockBetweenDirectParticipants(
    client: Pick<Prisma.TransactionClient, 'userBlock'>,
    senderId: string,
    members: Array<{ userId: string }>,
  ): Promise<boolean> {
    const otherUserId = members.find(
      (member) => member.userId !== senderId,
    )?.userId;
    if (!otherUserId) return true;

    const block = await client.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: senderId, blockedId: otherUserId },
          { blockerId: otherUserId, blockedId: senderId },
        ],
      },
      select: { blockerId: true },
    });
    return block !== null;
  }

  private latestDate(
    first: Date,
    ...candidates: Array<Date | null | undefined>
  ): Date {
    return candidates.reduce<Date>(
      (latest, candidate) =>
        candidate && candidate.getTime() > latest.getTime()
          ? candidate
          : latest,
      first,
    );
  }

  private isAfterBoundary(
    createdAt: Date,
    id: string,
    boundaryCreatedAt: Date | null,
    boundaryId: string | null,
  ): boolean {
    if (!boundaryCreatedAt || !boundaryId) return true;
    const timeDifference = createdAt.getTime() - boundaryCreatedAt.getTime();
    return timeDifference > 0 || (timeDifference === 0 && id > boundaryId);
  }

  private prismaErrorCode(error: unknown): string | undefined {
    return error instanceof Prisma.PrismaClientKnownRequestError
      ? error.code
      : undefined;
  }
}

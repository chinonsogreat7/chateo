import { createHash } from 'node:crypto';
import type { MessageResponseDto } from './dto/message-response.dto';
import type { MessageRecord } from './messages.types';

export function messageFingerprint(input: {
  conversationId: string;
  text: string | null;
  attachmentMediaIds: string[];
  replyToMessageId?: string | null;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.conversationId.toLowerCase(),
        input.text,
        input.attachmentMediaIds.map((id) => id.toLowerCase()),
        input.replyToMessageId?.toLowerCase() ?? null,
      ]),
    )
    .digest('hex');
}

export function messageResponse(message: MessageRecord): MessageResponseDto {
  const deleted = Boolean(message.deletedAt);
  return {
    id: message.id,
    conversationId: message.conversationId,
    clientMessageId: message.clientMessageId,
    senderId: message.senderId,
    kind: message.kind.toLowerCase() as MessageResponseDto['kind'],
    text: deleted ? null : message.text,
    attachments: deleted ? [] : message.attachments,
    createdAt: message.createdAt.toISOString(),
    replyToMessageId: deleted ? null : (message.replyToMessageId ?? null),
    editedAt: message.editedAt?.toISOString() ?? null,
    deletedAt: message.deletedAt?.toISOString() ?? null,
    version: message.version ?? 0,
    reactions: deleted ? [] : (message.reactions ?? []),
  };
}

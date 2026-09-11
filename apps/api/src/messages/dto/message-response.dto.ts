import {
  ApiExtraModels,
  ApiProperty,
  OmitType,
  getSchemaPath,
} from '@nestjs/swagger';

export class MessageAttachmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  mediaId!: string;

  @ApiProperty({ enum: ['image'] })
  type!: 'image';

  @ApiProperty({ example: 'image/jpeg' })
  contentType!: string;

  @ApiProperty({ minimum: 1 })
  sizeBytes!: number;

  @ApiProperty({ minimum: 1 })
  width!: number;

  @ApiProperty({ minimum: 1 })
  height!: number;

  @ApiProperty({ format: 'uri' })
  url!: string;
}

export class AudioMessageAttachmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  mediaId!: string;

  @ApiProperty({ enum: ['audio'] })
  type!: 'audio';

  @ApiProperty({ example: 'audio/m4a' })
  contentType!: string;

  @ApiProperty({ minimum: 1, maximum: 20 * 1024 * 1024 })
  sizeBytes!: number;

  @ApiProperty({
    minimum: 1,
    maximum: 900000,
    description: 'Audio recording duration in milliseconds.',
  })
  durationMs!: number;

  @ApiProperty({ format: 'uri' })
  url!: string;
}

export class VideoMessageAttachmentResponseDto extends OmitType(
  AudioMessageAttachmentResponseDto,
  ['type', 'sizeBytes', 'durationMs'] as const,
) {
  @ApiProperty({ enum: ['video'] })
  type!: 'video';
  @ApiProperty({ minimum: 1, maximum: 50 * 1024 * 1024 })
  sizeBytes!: number;
  @ApiProperty({ minimum: 1, maximum: 300000 })
  durationMs!: number;

  @ApiProperty({ minimum: 1, maximum: 1920 })
  width!: number;

  @ApiProperty({ minimum: 1, maximum: 1920 })
  height!: number;
}

export class DocumentMessageAttachmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  mediaId!: string;
  @ApiProperty({ enum: ['document'] })
  type!: 'document';
  @ApiProperty()
  contentType!: string;
  @ApiProperty({ minimum: 1, maximum: 25 * 1024 * 1024 })
  sizeBytes!: number;
  @ApiProperty({ maxLength: 255 })
  filename!: string;
  @ApiProperty({ format: 'uri' })
  url!: string;
}

export class MessageReactionResponseDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;
  @ApiProperty({ example: '👍' })
  emoji!: string;
}

@ApiExtraModels(
  MessageAttachmentResponseDto,
  AudioMessageAttachmentResponseDto,
  VideoMessageAttachmentResponseDto,
  DocumentMessageAttachmentResponseDto,
)
export class MessageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({
    enum: ['text', 'image', 'audio', 'video', 'document'],
    example: 'text',
  })
  kind!: 'text' | 'image' | 'audio' | 'video' | 'document';

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Hello! Are you free to chat?',
  })
  text!: string | null;

  @ApiProperty({
    type: 'array',
    items: {
      oneOf: [
        { $ref: getSchemaPath(MessageAttachmentResponseDto) },
        { $ref: getSchemaPath(AudioMessageAttachmentResponseDto) },
        { $ref: getSchemaPath(VideoMessageAttachmentResponseDto) },
        { $ref: getSchemaPath(DocumentMessageAttachmentResponseDto) },
      ],
      discriminator: {
        propertyName: 'type',
        mapping: {
          image: getSchemaPath(MessageAttachmentResponseDto),
          audio: getSchemaPath(AudioMessageAttachmentResponseDto),
          video: getSchemaPath(VideoMessageAttachmentResponseDto),
          document: getSchemaPath(DocumentMessageAttachmentResponseDto),
        },
      },
    },
  })
  attachments!: Array<
    | MessageAttachmentResponseDto
    | AudioMessageAttachmentResponseDto
    | VideoMessageAttachmentResponseDto
    | DocumentMessageAttachmentResponseDto
  >;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Fetch the referenced message with GET messages/:messageId; hidden/deleted content is never embedded in replies.',
  })
  replyToMessageId!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  editedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  deletedAt!: string | null;
  @ApiProperty({
    minimum: 0,
    description:
      'Monotonic revision for edits, deletion, and reactions. Ignore older socket snapshots.',
  })
  version!: number;
  @ApiProperty({ type: [MessageReactionResponseDto] })
  reactions!: MessageReactionResponseDto[];
}

export class MessagePageInfoDto {
  @ApiProperty({ type: String, nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  hasNextPage!: boolean;
}

export class MessageHistoryResponseDto {
  @ApiProperty({ type: [MessageResponseDto] })
  items!: MessageResponseDto[];

  @ApiProperty({ type: MessagePageInfoDto })
  pageInfo!: MessagePageInfoDto;
}

export class ConversationReadStateResponseDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ format: 'date-time' })
  lastReadAt!: string;

  @ApiProperty({ minimum: 0, example: 0 })
  unreadCount!: number;
}

export class ClearConversationMessagesResponseDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({
    description: 'Whether the stored clear boundary or unread state changed.',
  })
  changed!: boolean;

  @ApiProperty({ format: 'date-time', type: String, nullable: true })
  clearedAt!: string | null;

  @ApiProperty({ format: 'uuid', type: String, nullable: true })
  clearedThroughMessageId!: string | null;
}

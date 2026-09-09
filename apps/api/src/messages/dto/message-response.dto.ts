import { ApiExtraModels, ApiProperty, getSchemaPath } from '@nestjs/swagger';

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

@ApiExtraModels(MessageAttachmentResponseDto, AudioMessageAttachmentResponseDto)
export class MessageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ enum: ['text', 'image', 'audio'], example: 'text' })
  kind!: 'text' | 'image' | 'audio';

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
      ],
      discriminator: {
        propertyName: 'type',
        mapping: {
          image: getSchemaPath(MessageAttachmentResponseDto),
          audio: getSchemaPath(AudioMessageAttachmentResponseDto),
        },
      },
    },
  })
  attachments!: Array<
    MessageAttachmentResponseDto | AudioMessageAttachmentResponseDto
  >;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
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

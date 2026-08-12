import { ApiProperty } from '@nestjs/swagger';

export class MessageResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  clientMessageId!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ enum: ['text'], example: 'text' })
  kind!: 'text';

  @ApiProperty({ example: 'Hello! Are you free to chat?' })
  text!: string;

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

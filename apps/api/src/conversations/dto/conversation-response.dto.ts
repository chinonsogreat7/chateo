import { ApiProperty } from '@nestjs/swagger';

export class ConversationParticipantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ nullable: true, example: 'Ada Okafor' })
  displayName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uri',
    example: 'https://example.com/avatars/ada.jpg',
  })
  avatarUrl!: string | null;
}

export class ConversationLatestMessageDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  senderId!: string;

  @ApiProperty({ enum: ['text'], example: 'text' })
  kind!: 'text';

  @ApiProperty({ example: 'Hello!' })
  preview!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class ConversationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['direct'], example: 'direct' })
  type!: 'direct';

  @ApiProperty({ type: ConversationParticipantDto })
  otherParticipant!: ConversationParticipantDto;

  @ApiProperty({
    type: ConversationLatestMessageDto,
    nullable: true,
    example: null,
    description: 'Populated after message support is introduced.',
  })
  latestMessage!: ConversationLatestMessageDto | null;

  @ApiProperty({ minimum: 0, example: 0 })
  unreadCount!: number;

  @ApiProperty({ format: 'date-time' })
  lastActivityAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class ConversationPageInfoDto {
  @ApiProperty({ nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  hasNextPage!: boolean;
}

export class ConversationListResponseDto {
  @ApiProperty({ type: [ConversationResponseDto] })
  items!: ConversationResponseDto[];

  @ApiProperty({ type: ConversationPageInfoDto })
  pageInfo!: ConversationPageInfoDto;
}

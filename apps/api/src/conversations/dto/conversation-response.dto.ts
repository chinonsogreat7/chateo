import { ApiProperty, getSchemaPath } from '@nestjs/swagger';

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

export class GroupConversationParticipantDto extends ConversationParticipantDto {
  @ApiProperty({ enum: ['owner', 'admin', 'member'], example: 'member' })
  role!: 'owner' | 'admin' | 'member';
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

export class ConversationMemberSettingsDto {
  @ApiProperty()
  archived!: boolean;

  @ApiProperty()
  muted!: boolean;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  mutedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pinnedAt!: string | null;
}

abstract class ConversationResponseBaseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    type: ConversationLatestMessageDto,
    nullable: true,
    example: null,
    description: 'The newest message in the conversation, when present.',
  })
  latestMessage!: ConversationLatestMessageDto | null;

  @ApiProperty({ minimum: 0, example: 0 })
  unreadCount!: number;

  @ApiProperty({ type: ConversationMemberSettingsDto })
  settings!: ConversationMemberSettingsDto;

  @ApiProperty({ format: 'date-time' })
  lastActivityAt!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: string;
}

export class DirectConversationResponseDto extends ConversationResponseBaseDto {
  @ApiProperty({ enum: ['direct'], example: 'direct' })
  type!: 'direct';

  @ApiProperty({ type: ConversationParticipantDto })
  otherParticipant!: ConversationParticipantDto;
}

export class GroupConversationResponseDto extends ConversationResponseBaseDto {
  @ApiProperty({ enum: ['group'], example: 'group' })
  type!: 'group';

  @ApiProperty({ minLength: 1, maxLength: 100, example: 'Study Group' })
  name!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uri',
  })
  avatarUrl!: string | null;

  @ApiProperty({ type: [GroupConversationParticipantDto] })
  participants!: GroupConversationParticipantDto[];

  @ApiProperty({
    enum: ['owner', 'admin', 'member'],
    description: "The signed-in user's role in the group conversation.",
  })
  role!: 'owner' | 'admin' | 'member';
}

export type ConversationResponseDto =
  | DirectConversationResponseDto
  | GroupConversationResponseDto;

export const conversationResponseSchema = {
  oneOf: [
    { $ref: getSchemaPath(DirectConversationResponseDto) },
    { $ref: getSchemaPath(GroupConversationResponseDto) },
  ],
  discriminator: {
    propertyName: 'type',
    mapping: {
      direct: getSchemaPath(DirectConversationResponseDto),
      group: getSchemaPath(GroupConversationResponseDto),
    },
  },
};

export class ConversationPageInfoDto {
  @ApiProperty({ nullable: true })
  nextCursor!: string | null;

  @ApiProperty()
  hasNextPage!: boolean;
}

export class ConversationListResponseDto {
  @ApiProperty({ type: 'array', items: conversationResponseSchema })
  items!: ConversationResponseDto[];

  @ApiProperty({ type: ConversationPageInfoDto })
  pageInfo!: ConversationPageInfoDto;
}

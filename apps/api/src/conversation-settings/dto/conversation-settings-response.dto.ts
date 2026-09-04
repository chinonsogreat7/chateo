import { ApiProperty } from '@nestjs/swagger';

export class ConversationSettingsResponseDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty()
  archived!: boolean;

  @ApiProperty()
  muted!: boolean;

  @ApiProperty()
  pinned!: boolean;

  @ApiProperty()
  favorited!: boolean;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  mutedAt!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When a finite mute expires. Null when unmuted or muted indefinitely.',
  })
  mutedUntil!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pinnedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  favoritedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  clearedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  clearedThroughMessageId!: string | null;
}

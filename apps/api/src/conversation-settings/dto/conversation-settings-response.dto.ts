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

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  archivedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  mutedAt!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  pinnedAt!: string | null;
}

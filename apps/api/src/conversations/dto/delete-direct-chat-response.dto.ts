import { ApiProperty } from '@nestjs/swagger';

export class DeleteDirectChatResponseDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({
    description: 'False when this chat is already deleted for you.',
  })
  changed!: boolean;

  @ApiProperty({ format: 'date-time' })
  deletedAt!: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  clearedAt!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  clearedThroughMessageId!: string | null;
}

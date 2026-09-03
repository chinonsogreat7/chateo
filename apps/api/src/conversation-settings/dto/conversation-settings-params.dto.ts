import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ConversationSettingsParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

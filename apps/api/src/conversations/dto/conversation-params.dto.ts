import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ConversationParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

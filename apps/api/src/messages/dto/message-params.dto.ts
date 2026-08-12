import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MessageConversationParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

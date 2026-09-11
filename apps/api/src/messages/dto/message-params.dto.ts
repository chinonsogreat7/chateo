import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class MessageConversationParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

export class MessageParamsDto extends MessageConversationParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  messageId!: string;
}

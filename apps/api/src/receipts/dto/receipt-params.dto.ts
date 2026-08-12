import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ReceiptConversationParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;
}

import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { ListMessagesQueryDto } from './list-messages-query.dto';

export class SharedMediaQueryDto extends ListMessagesQueryDto {
  @ApiPropertyOptional({
    enum: ['image', 'audio', 'video', 'document'],
    description:
      'Omit for all attachment kinds. Pagination counts messages; flatten their attachments for a gallery.',
  })
  @IsOptional()
  @IsIn(['image', 'audio', 'video', 'document'])
  kind?: 'image' | 'audio' | 'video' | 'document';
}

export class MessageStarResponseDto {
  @ApiProperty({ format: 'uuid' }) conversationId!: string;
  @ApiProperty({ format: 'uuid' }) messageId!: string;
  @ApiProperty() starred!: boolean;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  starredAt!: string | null;
}

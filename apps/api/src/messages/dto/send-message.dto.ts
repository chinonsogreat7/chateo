import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsPostgresText } from '../validators/is-postgres-text.decorator';

export class SendMessageDto {
  @ApiProperty({
    format: 'uuid',
    example: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
    description:
      'A client-generated idempotency key. Retrying the same original request returns the current message, including any later edits or deletion placeholder.',
  })
  @IsUUID()
  clientMessageId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'A nondeleted message in this conversation that is visible in your history.',
  })
  @IsOptional()
  @IsUUID()
  replyToMessageId?: string;

  @ApiPropertyOptional({
    minLength: 1,
    maxLength: 4000,
    example: 'Hello! Are you free to chat?',
    description:
      'Text body or optional image/audio/video/document caption. Provide text or at least one attachment.',
  })
  @Transform(({ value }: { value: unknown }) => {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @IsPostgresText(4000)
  text?: string;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'string', format: 'uuid' },
    minItems: 1,
    maxItems: 10,
    uniqueItems: true,
    description:
      'Ordered ready message_attachment media IDs owned by the sender. Up to ten images, or exactly one audio, video, or document asset. Different attachment kinds cannot be mixed.',
    example: ['550e8400-e29b-41d4-a716-446655440000'],
  })
  @ValidateIf(
    (input: SendMessageDto) =>
      input.text === undefined ||
      input.text === null ||
      input.attachmentMediaIds !== undefined,
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique((value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID(undefined, { each: true })
  attachmentMediaIds?: string[];
}

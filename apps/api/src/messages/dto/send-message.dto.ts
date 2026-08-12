import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, MinLength, ValidateIf } from 'class-validator';
import { IsPostgresText } from '../validators/is-postgres-text.decorator';

export class SendMessageDto {
  @ApiProperty({
    format: 'uuid',
    example: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
    description:
      'A client-generated idempotency key. Reusing it with the same message returns the original message.',
  })
  @IsUUID()
  clientMessageId!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '55555555-5555-4555-8555-555555555555',
    description:
      'The message being replied to. It must belong to the same conversation.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsUUID()
  replyToMessageId?: string;

  @ApiProperty({
    minLength: 1,
    maxLength: 4000,
    example: 'Hello! Are you free to chat?',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @IsPostgresText(4000)
  text!: string;
}

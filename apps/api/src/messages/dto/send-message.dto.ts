import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MinLength } from 'class-validator';
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

import { Transform } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsString,
  Length,
  Min,
  ValidateIf,
} from 'class-validator';
import { IsPostgresText } from '../validators/is-postgres-text.decorator';
import { ListMessagesQueryDto } from './list-messages-query.dto';

export const MESSAGE_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

export class EditMessageDto {
  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 4000,
    description:
      'New text or caption. Null removes an attachment caption; text-only messages require nonblank text.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf((_object: EditMessageDto, value: unknown) => value !== null)
  @IsString()
  @IsPostgresText(4000)
  text!: string | null;

  @ApiProperty({
    minimum: 0,
    description:
      'The message version last read by this client; stale edits return 409.',
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}

export class SetMessageReactionDto {
  @ApiProperty({
    enum: MESSAGE_REACTIONS,
    example: '👍',
    description: 'Replaces your previous reaction on this message.',
  })
  @IsIn(MESSAGE_REACTIONS)
  emoji!: (typeof MESSAGE_REACTIONS)[number];
}

export class SearchMessagesQueryDto extends ListMessagesQueryDto {
  @ApiProperty({
    minLength: 2,
    maxLength: 100,
    description:
      'Literal case-insensitive text/caption search within this conversation.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 100)
  @IsPostgresText(100)
  q!: string;
}

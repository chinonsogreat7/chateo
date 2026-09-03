import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Length,
  MaxLength,
} from 'class-validator';

export class CreateGroupConversationDto {
  @ApiProperty({
    example: 'Study Group',
    minLength: 1,
    maxLength: 100,
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(1, 100)
  name!: string;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 99,
    uniqueItems: true,
    description:
      'The users to add to the group. Do not include the signed-in creator.',
    example: [
      '7d444840-9dc0-41d1-b245-5ffdce74fad2',
      '8e555951-aed1-42e2-8346-6aadece85be3',
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(99)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  participantIds!: string[];

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uri',
    example: 'https://example.com/groups/study-group.jpg',
    description: 'An optional URL supplied by the future media-upload service.',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  avatarUrl?: string | null;
}

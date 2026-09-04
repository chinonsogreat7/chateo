import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsUrl,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateGroupConversationDto {
  @ApiPropertyOptional({
    example: 'Project Team',
    minLength: 1,
    maxLength: 100,
    description: 'A new nonblank group name.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @ValidateIf(
    (_object: UpdateGroupConversationDto, value: unknown) =>
      value !== undefined,
  )
  @IsString()
  @Length(1, 100)
  name?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    format: 'uri',
    example: 'https://example.com/groups/project-team.jpg',
    description: 'A new avatar URL, or null to remove the current avatar.',
  })
  @ValidateIf(
    (_object: UpdateGroupConversationDto, value: unknown) =>
      value !== undefined && value !== null,
  )
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  avatarUrl?: string | null;
}

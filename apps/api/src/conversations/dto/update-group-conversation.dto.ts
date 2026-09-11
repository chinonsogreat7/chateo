import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsUUID, Length, ValidateIf } from 'class-validator';

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
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      'A ready group_avatar media ID owned by the acting owner/admin, or null to remove the avatar. Arbitrary avatarUrl inputs are not accepted.',
  })
  @ValidateIf(
    (_object: UpdateGroupConversationDto, value: unknown) =>
      value !== undefined && value !== null,
  )
  @IsUUID()
  avatarMediaId?: string | null;
}

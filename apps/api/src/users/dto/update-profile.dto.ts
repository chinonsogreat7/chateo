import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUrl,
  Length,
  MaxLength,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Great Ichoku', minLength: 2, maxLength: 80 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 80)
  displayName?: string;

  @ApiPropertyOptional({
    nullable: true,
    format: 'uri',
    description:
      'A URL returned by the future media-upload service, or null to remove.',
  })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  @MaxLength(2048)
  avatarUrl?: string | null;
}

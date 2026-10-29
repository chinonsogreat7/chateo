import { Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsString,
  Length,
  MaxLength,
  ValidateIf,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Great Ichoku', minLength: 2, maxLength: 80 })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 80)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'About/bio. Send an empty string to clear it.',
    maxLength: 160,
    example: 'Learning React Native',
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MaxLength(160)
  bio?: string;

  @ApiPropertyOptional({
    description:
      'Share your phone number with unblocked conversation participants.',
    default: false,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  sharePhoneNumber?: boolean;

  @ApiPropertyOptional({
    description:
      'Share your last authenticated socket activity with unblocked conversation participants.',
    default: false,
  })
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  shareLastSeen?: boolean;
}

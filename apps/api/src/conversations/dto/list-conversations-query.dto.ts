import { Transform, Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListConversationsQueryDto {
  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: 50,
    default: 20,
    example: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit: number = 20;

  @ApiPropertyOptional({
    type: Boolean,
    default: false,
    description:
      'When true, return archived conversations; otherwise return active conversations.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsBoolean()
  archived?: boolean;

  @ApiPropertyOptional({
    description: 'Opaque cursor returned by the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class ListConversationsQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 50,
    default: 20,
    example: 20,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit = 20;

  @ApiPropertyOptional({
    description: 'Opaque cursor returned by the previous page.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

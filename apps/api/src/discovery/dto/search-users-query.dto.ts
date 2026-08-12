import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SearchUsersQueryDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 80,
    example: 'Ada',
    description: 'A display-name search term. Phone numbers are not searched.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(3, 80)
  q!: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 25 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(25)
  limit = 20;

  @ApiPropertyOptional({
    description: 'Opaque cursor returned by the previous search response.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}

import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'The opaque refresh token returned at sign-in.',
    example:
      '550e8400-e29b-41d4-a716-446655440000.3fQ8xZ7uV2nK5mP9rT4wY6aB1cD0eF8gH2jL7sN5qRk',
  })
  @IsString()
  @MinLength(40)
  @MaxLength(512)
  refreshToken!: string;
}

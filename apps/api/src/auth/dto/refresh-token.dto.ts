import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({ description: 'The opaque refresh token returned at sign-in.' })
  @IsString()
  @MinLength(40)
  @MaxLength(512)
  refreshToken!: string;
}

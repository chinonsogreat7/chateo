import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+2348012345678' })
  phoneNumber!: string;

  @ApiPropertyOptional({ nullable: true, example: 'Great Ichoku' })
  displayName!: string | null;

  @ApiPropertyOptional({ nullable: true, format: 'uri' })
  avatarUrl!: string | null;

  @ApiProperty()
  profileComplete!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

export class OtpChallengeResponseDto {
  @ApiProperty({ format: 'uuid' })
  challengeId!: string;

  @ApiProperty({ example: '+234********78' })
  phoneNumberMasked!: string;

  @ApiProperty({ example: 300 })
  expiresInSeconds!: number;

  @ApiProperty({ example: 24 })
  resendInSeconds!: number;

  @ApiProperty({ example: 4, minimum: 4, maximum: 8 })
  codeLength!: number;
}

export class AuthResponseDto {
  @ApiProperty()
  accessToken!: string;

  @ApiProperty({ example: 900 })
  accessTokenExpiresInSeconds!: number;

  @ApiProperty()
  refreshToken!: string;

  @ApiProperty({ example: 2592000 })
  refreshTokenExpiresInSeconds!: number;

  @ApiProperty({ type: UserResponseDto })
  user!: UserResponseDto;
}

import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';

export enum DevicePlatformInput {
  IOS = 'ios',
  ANDROID = 'android',
  WEB = 'web',
  UNKNOWN = 'unknown',
}

export class AuthDeviceDto {
  @ApiPropertyOptional({ example: 'Great’s iPhone' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    enum: DevicePlatformInput,
    default: DevicePlatformInput.UNKNOWN,
    example: DevicePlatformInput.IOS,
  })
  @IsOptional()
  @IsEnum(DevicePlatformInput)
  platform?: DevicePlatformInput;
}

export class VerifyOtpDto {
  @ApiProperty({
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
  })
  @IsUUID()
  challengeId!: string;

  @ApiProperty({
    example: '1234',
    minLength: 4,
    maxLength: 8,
    description: 'Use the codeLength returned by the OTP request endpoint.',
  })
  @IsString()
  @Matches(/^\d{4,8}$/, { message: 'code must contain 4 to 8 digits' })
  code!: string;

  @ApiPropertyOptional({ type: AuthDeviceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => AuthDeviceDto)
  device?: AuthDeviceDto;
}

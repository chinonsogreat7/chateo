import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

export class PushDeviceParamsDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Stable random installation ID persisted by the app. Not a hardware identifier.',
  })
  @IsUUID()
  installationId!: string;
}
export class RegisterPushDeviceDto {
  @ApiProperty({ enum: ['ios', 'android'] })
  @IsIn(['ios', 'android'])
  platform!: 'ios' | 'android';

  @ApiProperty({
    example: 'ExpoPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    description:
      'An Expo push token from this installation. Native APNs/FCM tokens are not accepted.',
  })
  @IsString()
  @MaxLength(255)
  @Matches(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{10,220}\]$/)
  token!: string;
}
export class PushDeviceResponseDto {
  @ApiProperty({ format: 'uuid' })
  installationId!: string;
  @ApiProperty({ enum: ['ios', 'android'] })
  platform!: 'ios' | 'android';
  @ApiProperty({ format: 'date-time' })
  registeredAt!: string;
}

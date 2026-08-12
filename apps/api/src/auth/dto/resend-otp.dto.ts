import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ResendOtpDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  challengeId!: string;
}

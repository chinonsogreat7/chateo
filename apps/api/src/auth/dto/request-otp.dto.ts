import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class RequestOtpDto {
  @ApiProperty({
    example: '+2348012345678',
    description: 'A valid phone number in E.164 format.',
  })
  @IsString()
  @MaxLength(32)
  phoneNumber!: string;
}

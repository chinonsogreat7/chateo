import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class UpdateReceiptDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Latest incoming message included in this receipt update.',
    example: '44444444-4444-4444-8444-444444444444',
  })
  @IsUUID()
  throughMessageId!: string;
}

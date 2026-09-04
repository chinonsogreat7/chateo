import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class TransferGroupOwnershipDto {
  @ApiProperty({
    format: 'uuid',
    example: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
    description: 'An existing group member who will become the new owner.',
  })
  @IsUUID()
  newOwnerId!: string;
}

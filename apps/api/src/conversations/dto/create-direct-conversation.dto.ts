import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class CreateDirectConversationDto {
  @ApiProperty({
    format: 'uuid',
    example: '7d444840-9dc0-11d1-b245-5ffdce74fad2',
    description: 'The registered user to start a direct conversation with.',
  })
  @IsUUID()
  participantId!: string;
}

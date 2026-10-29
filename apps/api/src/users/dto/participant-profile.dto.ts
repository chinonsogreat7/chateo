import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class ParticipantProfileParamsDto {
  @IsUUID() conversationId!: string;
  @IsUUID() userId!: string;
}

export class ParticipantProfileResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true }) displayName!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'uri' }) avatarUrl!:
    string | null;
  @ApiProperty({ type: String, nullable: true, maxLength: 160 }) bio!:
    string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Null unless this participant opted in, or this is your own profile.',
  })
  phoneNumber!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    format: 'date-time',
    description:
      'Last authenticated socket observation. Null if unknown or not shared. Use presence events for online/offline status.',
  })
  lastSeenAt!: string | null;
}

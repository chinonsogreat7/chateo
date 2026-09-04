import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

export enum ConversationMuteDuration {
  EightHours = '8_hours',
  TwentyFourHours = '24_hours',
  SevenDays = '7_days',
  Always = 'always',
}

export class MuteConversationDto {
  @ApiProperty({
    enum: ConversationMuteDuration,
    example: ConversationMuteDuration.EightHours,
    description: 'How long notifications should remain muted.',
  })
  @IsEnum(ConversationMuteDuration)
  duration!: ConversationMuteDuration;
}

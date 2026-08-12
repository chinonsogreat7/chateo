import { ApiProperty } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray } from 'class-validator';

export class MatchContactsDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: 100,
    example: ['+234 801 234 5678', '+2348098765432'],
    description:
      'International phone numbers already known to the caller. Values must include + and are normalized to E.164 before matching.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  phoneNumbers!: unknown[];
}

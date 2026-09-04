import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

export class AddGroupMembersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    minItems: 1,
    maxItems: 99,
    uniqueItems: true,
    description:
      'Registered users to add atomically. Do not include yourself or an existing member.',
    example: [
      '7d444840-9dc0-41d1-b245-5ffdce74fad2',
      '8e555951-aed1-42e2-8346-6aadece85be3',
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(99)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  participantIds!: string[];
}

import { ApiProperty } from '@nestjs/swagger';

export class PublicDiscoveryUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ nullable: true, example: 'Ada Okafor' })
  displayName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    format: 'uri',
    example: 'https://example.com/avatars/ada.jpg',
  })
  avatarUrl!: string | null;
}

export class ContactMatchDto {
  @ApiProperty({ example: '+2348012345678' })
  matchedPhoneNumber!: string;

  @ApiProperty({ type: PublicDiscoveryUserDto })
  user!: PublicDiscoveryUserDto;
}

export class ContactMatchesResponseDto {
  @ApiProperty({ type: [ContactMatchDto] })
  matches!: ContactMatchDto[];
}

export class UserSearchResponseDto {
  @ApiProperty({ type: [PublicDiscoveryUserDto] })
  items!: PublicDiscoveryUserDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Pass this opaque value to cursor to request the next page.',
  })
  nextCursor!: string | null;
}

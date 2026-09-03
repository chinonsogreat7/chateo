import { ApiProperty } from '@nestjs/swagger';

export class BlockedPublicUserDto {
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

export class BlockResponseDto {
  @ApiProperty({ type: BlockedPublicUserDto })
  user!: BlockedPublicUserDto;

  @ApiProperty({ format: 'date-time' })
  blockedAt!: string;
}

export class BlockListResponseDto {
  @ApiProperty({ type: [BlockResponseDto] })
  items!: BlockResponseDto[];
}

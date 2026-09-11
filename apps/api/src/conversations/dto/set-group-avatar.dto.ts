import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class SetGroupAvatarDto {
  @ApiProperty({
    format: 'uuid',
    example: '550e8400-e29b-41d4-a716-446655440000',
    description:
      'A ready group_avatar media ID owned by the acting group owner or admin.',
  })
  @IsUUID()
  mediaId!: string;
}

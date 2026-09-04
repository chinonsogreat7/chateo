import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class UpdateGroupMemberRoleDto {
  @ApiProperty({
    enum: ['admin', 'member'],
    example: 'admin',
    description:
      'Promote a member to admin or demote an admin to member. Ownership is transferred separately.',
  })
  @IsIn(['admin', 'member'])
  role!: 'admin' | 'member';
}

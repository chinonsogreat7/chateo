import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class GroupMemberParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  conversationId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  memberId!: string;
}

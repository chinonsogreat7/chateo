import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class BlockTargetParamsDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  userId!: string;
}

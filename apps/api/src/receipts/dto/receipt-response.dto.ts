import { ApiProperty } from '@nestjs/swagger';

export class ReceiptBoundaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  messageId!: string;

  @ApiProperty({ format: 'date-time' })
  at!: string;
}

export class ReceiptUpdateResponseDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ enum: ['delivered', 'read'] })
  status!: 'delivered' | 'read';

  @ApiProperty({ format: 'uuid' })
  throughMessageId!: string;

  @ApiProperty({ format: 'date-time' })
  at!: string;

  @ApiProperty({
    description: 'False when this boundary had already been persisted.',
  })
  changed!: boolean;

  @ApiProperty({ minimum: 0 })
  unreadCount!: number;

  @ApiProperty({ minimum: 0 })
  version!: number;

  @ApiProperty({ type: ReceiptBoundaryResponseDto })
  delivered!: ReceiptBoundaryResponseDto;

  @ApiProperty({ type: ReceiptBoundaryResponseDto, nullable: true })
  read!: ReceiptBoundaryResponseDto | null;
}

export class ReceiptFrontierResponseDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ minimum: 0 })
  version!: number;

  @ApiProperty({
    type: ReceiptBoundaryResponseDto,
    nullable: true,
  })
  delivered!: ReceiptBoundaryResponseDto | null;

  @ApiProperty({
    type: ReceiptBoundaryResponseDto,
    nullable: true,
  })
  read!: ReceiptBoundaryResponseDto | null;
}

export class ReceiptFrontiersResponseDto {
  @ApiProperty({ format: 'uuid' })
  conversationId!: string;

  @ApiProperty({ type: [ReceiptFrontierResponseDto] })
  items!: ReceiptFrontierResponseDto[];
}

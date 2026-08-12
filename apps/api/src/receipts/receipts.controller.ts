import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { ReceiptConversationParamsDto } from './dto/receipt-params.dto';
import {
  ReceiptFrontiersResponseDto,
  ReceiptUpdateResponseDto,
} from './dto/receipt-response.dto';
import { UpdateReceiptDto } from './dto/update-receipt.dto';
import { ReceiptsService } from './receipts.service';

@ApiTags('receipts')
@ApiBearerAuth()
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class ReceiptsController {
  constructor(private readonly receiptsService: ReceiptsService) {}

  @Put(':conversationId/receipts/delivered')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark incoming messages as delivered' })
  @ApiBody({
    type: UpdateReceiptDto,
    examples: {
      default: {
        summary: 'Persist a delivery boundary',
        value: {
          throughMessageId: '44444444-4444-4444-8444-444444444444',
        },
      },
    },
  })
  @ApiOkResponse({ type: ReceiptUpdateResponseDto })
  @ApiNotFoundResponse({
    description:
      'The conversation, membership, or incoming message boundary is inaccessible.',
  })
  markDelivered(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ReceiptConversationParamsDto,
    @Body() input: UpdateReceiptDto,
  ): Promise<ReceiptUpdateResponseDto> {
    return this.receiptsService.markDelivered(
      user.sub,
      params.conversationId,
      input.throughMessageId,
    );
  }

  @Put(':conversationId/receipts/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark incoming messages as read' })
  @ApiBody({
    type: UpdateReceiptDto,
    examples: {
      default: {
        summary: 'Persist a read boundary',
        value: {
          throughMessageId: '44444444-4444-4444-8444-444444444444',
        },
      },
    },
  })
  @ApiOkResponse({ type: ReceiptUpdateResponseDto })
  @ApiNotFoundResponse({
    description:
      'The conversation, membership, or incoming message boundary is inaccessible.',
  })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ReceiptConversationParamsDto,
    @Body() input: UpdateReceiptDto,
  ): Promise<ReceiptUpdateResponseDto> {
    return this.receiptsService.markRead(
      user.sub,
      params.conversationId,
      input.throughMessageId,
    );
  }

  @Get(':conversationId/receipts')
  @ApiOperation({ summary: 'Reconcile participant receipt frontiers' })
  @ApiOkResponse({ type: ReceiptFrontiersResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ReceiptConversationParamsDto,
  ): Promise<ReceiptFrontiersResponseDto> {
    return this.receiptsService.list(user.sub, params.conversationId);
  }
}

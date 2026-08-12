import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import { MessageConversationParamsDto } from './dto/message-params.dto';
import {
  ConversationReadStateResponseDto,
  MessageHistoryResponseDto,
  MessageResponseDto,
} from './dto/message-response.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { MessagesService } from './messages.service';

@ApiTags('messages')
@ApiBearerAuth()
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post(':conversationId/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Persist or replay an idempotent text message' })
  @ApiBody({
    type: SendMessageDto,
    examples: {
      default: {
        summary: 'Send a text message',
        value: {
          clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
          text: 'Hello! Are you free to chat?',
        },
      },
    },
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  @ApiConflictResponse({
    description: 'The client message ID was reused with different data.',
  })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Body() input: SendMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.send(user.sub, params.conversationId, input);
  }

  @Get(':conversationId/messages')
  @ApiOperation({ summary: 'List message history, newest first' })
  @ApiOkResponse({ type: MessageHistoryResponseDto })
  @ApiBadRequestResponse({ description: 'The message cursor is invalid.' })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessageHistoryResponseDto> {
    return this.messagesService.list(
      user.sub,
      params.conversationId,
      query.limit,
      query.cursor,
    );
  }

  @Post(':conversationId/read')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark all currently persisted messages as read' })
  @ApiOkResponse({ type: ConversationReadStateResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  markRead(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
  ): Promise<ConversationReadStateResponseDto> {
    return this.messagesService.markRead(user.sub, params.conversationId);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Patch,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import {
  MessageConversationParamsDto,
  MessageParamsDto,
} from './dto/message-params.dto';
import {
  EditMessageDto,
  SearchMessagesQueryDto,
  SetMessageReactionDto,
} from './dto/message-actions.dto';
import {
  ClearConversationMessagesResponseDto,
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
  @ApiOperation({ summary: 'Persist or replay an idempotent message' })
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
      image: {
        summary: 'Send an image message with an optional caption',
        value: {
          clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
          text: 'Class photo',
          attachmentMediaIds: ['550e8400-e29b-41d4-a716-446655440000'],
        },
      },
      audio: {
        summary: 'Send one audio recording with an optional caption',
        value: {
          clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
          attachmentMediaIds: ['550e8400-e29b-41d4-a716-446655440000'],
        },
      },
      video: {
        summary: 'Send one verified video with a caption',
        value: {
          clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad3',
          text: 'Video lesson',
          attachmentMediaIds: ['550e8400-e29b-41d4-a716-446655440001'],
        },
      },
      document: {
        summary: 'Send one verified document',
        value: {
          clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad4',
          attachmentMediaIds: ['550e8400-e29b-41d4-a716-446655440002'],
        },
      },
      reply: {
        summary: 'Reply to a visible message in this chat',
        value: {
          clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad5',
          text: 'Thanks for the lesson!',
          replyToMessageId: '550e8400-e29b-41d4-a716-446655440003',
        },
      },
    },
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  @ApiConflictResponse({
    description:
      'The client message ID was reused with different data, an attachment is unavailable, or the reply target is unavailable.',
  })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Body() input: SendMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.send(user.sub, params.conversationId, input);
  }

  @Get(':conversationId/messages/search')
  @ApiOperation({
    summary: 'Search visible message text and captions, newest first',
  })
  @ApiOkResponse({ type: MessageHistoryResponseDto })
  @ApiBadRequestResponse({
    description:
      'Invalid search text or cursor; search cursors are bound to their query and conversation.',
  })
  @ApiNotFoundResponse({ description: 'The conversation is inaccessible.' })
  search(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Query() query: SearchMessagesQueryDto,
  ): Promise<MessageHistoryResponseDto> {
    return this.messagesService.list(
      user.sub,
      params.conversationId,
      query.limit,
      query.cursor,
      query.q,
    );
  }

  @Get(':conversationId/messages/:messageId')
  @ApiOperation({
    summary:
      'Get one visible message, including a reply target or deletion placeholder',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({
    description:
      'The message is missing or outside the caller’s visible history.',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.get(
      user.sub,
      params.conversationId,
      params.messageId,
    );
  }

  @Patch(':conversationId/messages/:messageId')
  @ApiOperation({ summary: 'Edit your own message text or attachment caption' })
  @ApiBody({
    type: EditMessageDto,
    examples: {
      default: { value: { text: 'Updated message', expectedVersion: 0 } },
    },
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid text or version; text-only messages cannot be empty.',
  })
  @ApiForbiddenResponse({ description: 'Only the sender can edit.' })
  @ApiNotFoundResponse({
    description: 'Message is missing, hidden, or blocked.',
  })
  @ApiConflictResponse({
    description: 'MESSAGE_DELETED or MESSAGE_VERSION_CONFLICT.',
  })
  edit(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
    @Body() input: EditMessageDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.edit(
      user.sub,
      params.conversationId,
      params.messageId,
      input,
    );
  }

  @Delete(':conversationId/messages/:messageId')
  @ApiOperation({
    summary: 'Delete your own message for everyone, idempotently',
    description:
      'Leaves a placeholder and preserves order/receipts. Text, attachments and reactions disappear from API responses. This does not revoke existing public Cloudinary URLs.',
  })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiForbiddenResponse({ description: 'Only the sender can delete.' })
  @ApiNotFoundResponse({
    description: 'Message is missing, hidden, or blocked.',
  })
  delete(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.delete(
      user.sub,
      params.conversationId,
      params.messageId,
    );
  }

  @Put(':conversationId/messages/:messageId/reaction')
  @ApiOperation({ summary: 'Set or replace your reaction, idempotently' })
  @ApiBody({ type: SetMessageReactionDto })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiBadRequestResponse({ description: 'Unsupported emoji.' })
  @ApiNotFoundResponse({
    description: 'Message is missing, hidden, or blocked.',
  })
  @ApiConflictResponse({ description: 'MESSAGE_DELETED.' })
  react(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
    @Body() input: SetMessageReactionDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.react(
      user.sub,
      params.conversationId,
      params.messageId,
      input.emoji,
    );
  }

  @Delete(':conversationId/messages/:messageId/reaction')
  @ApiOperation({ summary: 'Remove your reaction, idempotently' })
  @ApiOkResponse({ type: MessageResponseDto })
  @ApiNotFoundResponse({
    description: 'Message is missing, hidden, or blocked.',
  })
  @ApiConflictResponse({ description: 'MESSAGE_DELETED.' })
  unreact(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
  ): Promise<MessageResponseDto> {
    return this.messagesService.react(
      user.sub,
      params.conversationId,
      params.messageId,
      null,
    );
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

  @Delete(':conversationId/messages')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Clear the caller's message history for a conversation",
  })
  @ApiOkResponse({
    type: ClearConversationMessagesResponseDto,
    description:
      'The current history was hidden for this member. Shared messages were not deleted.',
  })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  clear(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
  ): Promise<ClearConversationMessagesResponseDto> {
    return this.messagesService.clear(user.sub, params.conversationId);
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

import {
  Controller,
  Delete,
  Get,
  Param,
  Put,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import {
  MessageConversationParamsDto,
  MessageParamsDto,
} from './dto/message-params.dto';
import { ListMessagesQueryDto } from './dto/list-messages-query.dto';
import {
  MessageStarResponseDto,
  SharedMediaQueryDto,
} from './dto/message-collections.dto';
import { MessageHistoryResponseDto } from './dto/message-response.dto';
import { MessageStarsService } from './message-stars.service';
import { MessagesService } from './messages.service';

@ApiTags('chat collections')
@ApiBearerAuth()
@ApiBadRequestResponse({
  description:
    'Invalid UUID, query or cursor. Collection cursors are bound to caller, conversation, collection and media kind.',
})
@ApiNotFoundResponse({
  description:
    'Conversation/message is missing or outside your visible history.',
})
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class MessageCollectionsController {
  constructor(
    private readonly messages: MessagesService,
    private readonly stars: MessageStarsService,
  ) {}

  @Get(':conversationId/shared-media')
  @ApiOperation({
    summary: 'List messages with shared media, newest first',
    description:
      'Returns messages with image/audio/video/document attachments. Paginate messages, then flatten attachments in their existing order. Deleted messages and cleared history are excluded.',
  })
  @ApiOkResponse({ type: MessageHistoryResponseDto })
  media(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Query() query: SharedMediaQueryDto,
  ): Promise<MessageHistoryResponseDto> {
    return this.messages.list(
      user.sub,
      params.conversationId,
      query.limit,
      query.cursor,
      undefined,
      { collection: 'media', ...(query.kind ? { kind: query.kind } : {}) },
    );
  }

  @Get(':conversationId/shared-links')
  @ApiOperation({
    summary: 'List messages containing shared HTTP(S) links, newest first',
    description:
      'Use each message’s links array. Links reflect current text/captions, including edits. Deleted and cleared messages are excluded.',
  })
  @ApiOkResponse({ type: MessageHistoryResponseDto })
  links(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessageHistoryResponseDto> {
    return this.messages.list(
      user.sub,
      params.conversationId,
      query.limit,
      query.cursor,
      undefined,
      { collection: 'links' },
    );
  }

  @Get(':conversationId/starred-messages')
  @ApiOperation({
    summary: 'List your starred messages in a chat, newest message first',
    description:
      'Stars are private and distinct from favorite conversations. Clearing history, deleting a message or losing membership makes those messages unavailable here. Refetch on screen focus to sync your devices.',
  })
  @ApiOkResponse({ type: MessageHistoryResponseDto })
  starred(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageConversationParamsDto,
    @Query() query: ListMessagesQueryDto,
  ): Promise<MessageHistoryResponseDto> {
    return this.messages.list(
      user.sub,
      params.conversationId,
      query.limit,
      query.cursor,
      undefined,
      { collection: 'starred' },
    );
  }

  @Get(':conversationId/messages/:messageId/star')
  @ApiOperation({
    summary: 'Read your private star state for a visible message',
  })
  @ApiOkResponse({ type: MessageStarResponseDto })
  getStar(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
  ): Promise<MessageStarResponseDto> {
    return this.stars.get(user.sub, params.conversationId, params.messageId);
  }

  @Put(':conversationId/messages/:messageId/star')
  @ApiOperation({
    summary: 'Star a visible message for yourself, idempotently',
  })
  @ApiOkResponse({ type: MessageStarResponseDto })
  star(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
  ): Promise<MessageStarResponseDto> {
    return this.stars.set(
      user.sub,
      params.conversationId,
      params.messageId,
      true,
    );
  }

  @Delete(':conversationId/messages/:messageId/star')
  @ApiOperation({
    summary: 'Unstar a visible message for yourself, idempotently',
  })
  @ApiOkResponse({ type: MessageStarResponseDto })
  unstar(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MessageParamsDto,
  ): Promise<MessageStarResponseDto> {
    return this.stars.set(
      user.sub,
      params.conversationId,
      params.messageId,
      false,
    );
  }
}

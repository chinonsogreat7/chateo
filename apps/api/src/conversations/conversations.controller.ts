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
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { ConversationsService } from './conversations.service';
import { ConversationParamsDto } from './dto/conversation-params.dto';
import {
  ConversationListResponseDto,
  ConversationResponseDto,
} from './dto/conversation-response.dto';
import { CreateDirectConversationDto } from './dto/create-direct-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';

const PARTICIPANT_ID_EXAMPLE = '7d444840-9dc0-11d1-b245-5ffdce74fad2';

@ApiTags('conversations')
@ApiBearerAuth()
@ApiExtraModels(CreateDirectConversationDto)
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Post('direct')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Create or return an existing direct conversation',
  })
  @ApiBody({
    schema: { $ref: getSchemaPath(CreateDirectConversationDto) },
    examples: {
      default: {
        summary: 'Start a direct conversation with a registered user',
        value: { participantId: PARTICIPANT_ID_EXAMPLE },
      },
    },
  })
  @ApiOkResponse({ type: ConversationResponseDto })
  createDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDirectConversationDto,
  ): Promise<ConversationResponseDto> {
    return this.conversationsService.createDirect(
      user.sub,
      input.participantId,
    );
  }

  @Get()
  @ApiOperation({ summary: 'List the signed-in user conversations' })
  @ApiOkResponse({ type: ConversationListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListConversationsQueryDto,
  ): Promise<ConversationListResponseDto> {
    return this.conversationsService.list(user.sub, query.limit, query.cursor);
  }

  @Get(':conversationId')
  @ApiOperation({ summary: 'Get a conversation by ID' })
  @ApiOkResponse({ type: ConversationResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationParamsDto,
  ): Promise<ConversationResponseDto> {
    return this.conversationsService.get(user.sub, params.conversationId);
  }
}

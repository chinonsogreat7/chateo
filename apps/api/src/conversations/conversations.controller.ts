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
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
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
  DirectConversationResponseDto,
  GroupConversationResponseDto,
  conversationResponseSchema,
} from './dto/conversation-response.dto';
import type { ConversationResponseDto } from './dto/conversation-response.dto';
import { CreateDirectConversationDto } from './dto/create-direct-conversation.dto';
import { CreateGroupConversationDto } from './dto/create-group-conversation.dto';
import { ListConversationsQueryDto } from './dto/list-conversations-query.dto';

const PARTICIPANT_ID_EXAMPLE = '7d444840-9dc0-11d1-b245-5ffdce74fad2';

@ApiTags('conversations')
@ApiBearerAuth()
@ApiExtraModels(
  CreateDirectConversationDto,
  CreateGroupConversationDto,
  DirectConversationResponseDto,
  GroupConversationResponseDto,
)
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
  @ApiOkResponse({ type: DirectConversationResponseDto })
  createDirect(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateDirectConversationDto,
  ): Promise<DirectConversationResponseDto> {
    return this.conversationsService.createDirect(
      user.sub,
      input.participantId,
    );
  }

  @Post('group')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a group conversation' })
  @ApiBody({
    schema: { $ref: getSchemaPath(CreateGroupConversationDto) },
    examples: {
      default: {
        summary: 'Start a named group with registered users',
        value: {
          name: 'Study Group',
          participantIds: [
            '7d444840-9dc0-41d1-b245-5ffdce74fad2',
            '8e555951-aed1-42e2-8346-6aadece85be3',
          ],
        },
      },
    },
  })
  @ApiCreatedResponse({ type: GroupConversationResponseDto })
  @ApiBadRequestResponse({
    description:
      'The group name or participant list is invalid, duplicated, or includes the creator.',
  })
  @ApiNotFoundResponse({
    description: 'One or more selected users do not exist.',
  })
  createGroup(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateGroupConversationDto,
  ): Promise<GroupConversationResponseDto> {
    return this.conversationsService.createGroup(user.sub, input);
  }

  @Get()
  @ApiOperation({ summary: 'List the signed-in user conversations' })
  @ApiOkResponse({ type: ConversationListResponseDto })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListConversationsQueryDto,
  ): Promise<ConversationListResponseDto> {
    return this.conversationsService.list(
      user.sub,
      query.limit,
      query.cursor,
      query.archived,
    );
  }

  @Get(':conversationId')
  @ApiOperation({ summary: 'Get a conversation by ID' })
  @ApiOkResponse({ schema: conversationResponseSchema })
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

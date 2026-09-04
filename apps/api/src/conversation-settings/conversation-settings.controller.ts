import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { ConversationSettingsService } from './conversation-settings.service';
import { ConversationSettingsParamsDto } from './dto/conversation-settings-params.dto';
import { ConversationSettingsResponseDto } from './dto/conversation-settings-response.dto';
import { MuteConversationDto } from './dto/mute-conversation.dto';
import { UpdateConversationSettingsDto } from './dto/update-conversation-settings.dto';

@ApiTags('conversation settings')
@ApiBearerAuth()
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class ConversationSettingsController {
  constructor(private readonly settingsService: ConversationSettingsService) {}

  @Patch(':conversationId/settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update the signed-in user conversation settings' })
  @ApiBody({
    type: UpdateConversationSettingsDto,
    examples: {
      default: {
        summary: 'Archive, unmute, and pin a conversation',
        value: { archived: true, muted: false, pinned: true },
      },
    },
  })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiBadRequestResponse({
    description: 'No supported conversation setting was provided.',
  })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
    @Body() input: UpdateConversationSettingsDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.update(user.sub, params.conversationId, input);
  }

  @Put(':conversationId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive a conversation for the signed-in user' })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiBadRequestResponse({ description: 'The conversation ID is invalid.' })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.setArchived(
      user.sub,
      params.conversationId,
      true,
    );
  }

  @Delete(':conversationId/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unarchive a conversation for the signed-in user' })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiBadRequestResponse({ description: 'The conversation ID is invalid.' })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  unarchive(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.setArchived(
      user.sub,
      params.conversationId,
      false,
    );
  }

  @Put(':conversationId/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mute a conversation for a selected duration' })
  @ApiBody({ type: MuteConversationDto })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiBadRequestResponse({
    description: 'The mute duration is missing or unsupported.',
  })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  mute(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
    @Body() input: MuteConversationDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.mute(
      user.sub,
      params.conversationId,
      input.duration,
    );
  }

  @Delete(':conversationId/mute')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unmute a conversation' })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  unmute(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.unmute(user.sub, params.conversationId);
  }

  @Put(':conversationId/favorite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Add a conversation to favorites' })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  favorite(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.setFavorite(
      user.sub,
      params.conversationId,
      true,
    );
  }

  @Delete(':conversationId/favorite')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a conversation from favorites' })
  @ApiOkResponse({ type: ConversationSettingsResponseDto })
  @ApiNotFoundResponse({
    description: 'The conversation is missing or the user is not a member.',
  })
  unfavorite(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ConversationSettingsParamsDto,
  ): Promise<ConversationSettingsResponseDto> {
    return this.settingsService.setFavorite(
      user.sub,
      params.conversationId,
      false,
    );
  }
}

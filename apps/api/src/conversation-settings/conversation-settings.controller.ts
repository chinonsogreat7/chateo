import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
}

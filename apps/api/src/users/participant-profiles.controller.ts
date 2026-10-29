import { Controller, Get, Param, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import {
  ParticipantProfileParamsDto,
  ParticipantProfileResponseDto,
} from './dto/participant-profile.dto';
import { ParticipantProfilesService } from './participant-profiles.service';

@ApiTags('profile')
@ApiBearerAuth()
@Controller('conversations')
@UseInterceptors(NoStoreInterceptor)
export class ParticipantProfilesController {
  constructor(private readonly profiles: ParticipantProfilesService) {}

  @Get(':conversationId/participants/:userId')
  @ApiOperation({
    summary: 'Read a current conversation participant’s profile',
    description:
      'Both users must be current members. Blocks in either direction return 404. Phone and last-seen sharing are opt-in. Search and conversation summaries continue to exclude these fields.',
  })
  @ApiOkResponse({ type: ParticipantProfileResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid UUID.' })
  @ApiNotFoundResponse({
    description: 'Participant unavailable, blocked, or caller not a member.',
  })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: ParticipantProfileParamsDto,
  ): Promise<ParticipantProfileResponseDto> {
    return this.profiles.get(user.sub, params.conversationId, params.userId);
  }
}

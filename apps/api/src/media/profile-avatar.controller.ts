import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { UserResponseDto } from '../auth/dto/auth-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { SetProfileAvatarDto } from './dto/set-profile-avatar.dto';
import { MediaService } from './media.service';

@ApiTags('profile')
@ApiBearerAuth()
@Controller('me/avatar')
@UseInterceptors(NoStoreInterceptor)
export class ProfileAvatarController {
  constructor(private readonly mediaService: MediaService) {}

  @Put()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Select a completed upload as the profile avatar' })
  @ApiBody({
    type: SetProfileAvatarDto,
    examples: {
      default: {
        summary: 'Select a ready profile avatar',
        value: { mediaId: '550e8400-e29b-41d4-a716-446655440000' },
      },
    },
  })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiBadRequestResponse({ description: 'The media ID is invalid.' })
  @ApiNotFoundResponse({
    description: 'The media is missing or belongs to another user.',
  })
  @ApiConflictResponse({ description: 'The media upload is not ready.' })
  set(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: SetProfileAvatarDto,
  ): Promise<UserResponseDto> {
    return this.mediaService.setProfileAvatar(user.sub, input.mediaId);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Remove the signed-in user profile avatar' })
  @ApiNoContentResponse({ description: 'The avatar is absent.' })
  remove(@CurrentUser() user: AuthenticatedUser): Promise<void> {
    return this.mediaService.clearProfileAvatar(user.sub);
  }
}

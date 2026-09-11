import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Clock } from '../auth/providers/clock';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ApiException } from '../common/errors/api.exception';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { PushRepository } from './push.repository';
import {
  PushDeviceParamsDto,
  PushDeviceResponseDto,
  RegisterPushDeviceDto,
} from './push.dto';

@ApiTags('push notifications')
@ApiBearerAuth()
@ApiUnauthorizedResponse({
  description: 'A current login session is required.',
})
@UseInterceptors(NoStoreInterceptor)
@Controller('me/push-devices')
export class PushController {
  constructor(
    private readonly repository: PushRepository,
    private readonly clock: Clock,
    private readonly config: ConfigService,
  ) {}

  @Put(':installationId')
  @ApiOperation({
    summary: 'Register or rotate this installation’s Expo push token',
    description:
      'Bound to the current login family, surviving token refresh but not logout. Re-register on login and token changes. Tokens are never returned.',
  })
  @ApiBody({ type: RegisterPushDeviceDto })
  @ApiOkResponse({ type: PushDeviceResponseDto })
  @ApiBadRequestResponse({
    description: 'Invalid installation ID, platform, or Expo token.',
  })
  @ApiTooManyRequestsResponse({
    description: 'At most 20 active installations per user.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Push notifications are disabled.',
  })
  async register(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: PushDeviceParamsDto,
    @Body() input: RegisterPushDeviceDto,
  ): Promise<PushDeviceResponseDto> {
    if (!this.config.get<boolean>('PUSH_NOTIFICATIONS_ENABLED', false))
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'PUSH_DISABLED',
        'Push notifications are not enabled on this server.',
      );
    const result = await this.repository.register(
      user.sub.toLowerCase(),
      user.sid.toLowerCase(),
      params.installationId.toLowerCase(),
      input,
      this.clock.now(),
    );
    if (result.status === 'unauthorized')
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_SESSION_INVALID',
        'The login session is no longer active.',
      );
    if (result.status === 'limit')
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'PUSH_DEVICE_LIMIT',
        'Remove an old push registration before adding another.',
      );
    if (result.status === 'unavailable')
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'PUSH_INSTALLATION_UNAVAILABLE',
        'Use a new installation ID for this registration.',
      );
    return result.device;
  }
  @Delete(':installationId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Unregister this installation from the current login, idempotently',
  })
  @ApiNoContentResponse()
  async unregister(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: PushDeviceParamsDto,
  ): Promise<void> {
    await this.repository.unregister(
      user.sub.toLowerCase(),
      user.sid.toLowerCase(),
      params.installationId.toLowerCase(),
      this.clock.now(),
    );
  }
}

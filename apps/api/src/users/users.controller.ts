import { Body, Controller, Get, Patch, UseInterceptors } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { UserResponseDto } from '../auth/dto/auth-response.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';

@ApiTags('profile')
@ApiBearerAuth()
@ApiExtraModels(UpdateProfileDto)
@Controller('me')
@UseInterceptors(NoStoreInterceptor)
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'Get the signed-in user profile' })
  @ApiOkResponse({ type: UserResponseDto })
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<UserResponseDto> {
    return this.usersService.getMe(user.sub);
  }

  @Patch()
  @ApiOperation({ summary: 'Complete or update the signed-in user profile' })
  @ApiBody({
    schema: { $ref: getSchemaPath(UpdateProfileDto) },
    examples: {
      default: {
        summary: 'Complete the signed-in user profile',
        value: {
          displayName: 'Great Ichoku',
          avatarUrl: 'https://example.com/avatars/great.jpg',
        },
      },
    },
  })
  @ApiOkResponse({ type: UserResponseDto })
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    return this.usersService.updateMe(user.sub, input);
  }
}

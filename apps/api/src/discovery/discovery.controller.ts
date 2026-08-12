import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { DiscoveryService } from './discovery.service';
import {
  ContactMatchesResponseDto,
  UserSearchResponseDto,
} from './dto/discovery-response.dto';
import { MatchContactsDto } from './dto/match-contacts.dto';
import { SearchUsersQueryDto } from './dto/search-users-query.dto';

@ApiTags('discovery')
@ApiBearerAuth()
@ApiExtraModels(MatchContactsDto)
@Controller()
@UseInterceptors(NoStoreInterceptor)
export class DiscoveryController {
  constructor(private readonly discoveryService: DiscoveryService) {}

  @Post('contacts/match')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Match phone numbers already present in the caller contacts',
  })
  @ApiBody({
    schema: { $ref: getSchemaPath(MatchContactsDto) },
    examples: {
      default: {
        summary: 'Match and normalize a batch of international phone numbers',
        value: {
          phoneNumbers: ['+234 801 234 5678', '+2348098765432'],
        },
      },
    },
  })
  @ApiOkResponse({ type: ContactMatchesResponseDto })
  matchContacts(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: MatchContactsDto,
  ): Promise<ContactMatchesResponseDto> {
    return this.discoveryService.matchContacts(user.sub, input.phoneNumbers);
  }

  @Get('users/search')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({ summary: 'Search completed profiles by display name' })
  @ApiOkResponse({ type: UserSearchResponseDto })
  searchUsers(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: SearchUsersQueryDto,
  ): Promise<UserSearchResponseDto> {
    return this.discoveryService.searchUsers(user.sub, query);
  }
}

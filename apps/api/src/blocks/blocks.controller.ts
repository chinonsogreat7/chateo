import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { BlocksService } from './blocks.service';
import { BlockTargetParamsDto } from './dto/block-params.dto';
import {
  BlockListResponseDto,
  BlockResponseDto,
} from './dto/block-response.dto';

@ApiTags('blocks')
@ApiBearerAuth()
@Controller('me/blocks')
@UseInterceptors(NoStoreInterceptor)
export class BlocksController {
  constructor(private readonly blocksService: BlocksService) {}

  @Get()
  @ApiOperation({ summary: 'List users blocked by the signed-in user' })
  @ApiOkResponse({ type: BlockListResponseDto })
  list(@CurrentUser() user: AuthenticatedUser): Promise<BlockListResponseDto> {
    return this.blocksService.list(user.sub);
  }

  @Put(':userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a user idempotently' })
  @ApiOkResponse({ type: BlockResponseDto })
  @ApiBadRequestResponse({ description: 'A user cannot block themselves.' })
  @ApiNotFoundResponse({ description: 'The selected user does not exist.' })
  block(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: BlockTargetParamsDto,
  ): Promise<BlockResponseDto> {
    return this.blocksService.block(user.sub, params.userId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Unblock a user idempotently' })
  @ApiNoContentResponse({ description: 'The block is absent.' })
  unblock(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: BlockTargetParamsDto,
  ): Promise<void> {
    return this.blocksService.unblock(user.sub, params.userId);
  }
}

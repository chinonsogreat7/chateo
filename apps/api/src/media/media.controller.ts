import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import { CreateMediaUploadDto } from './dto/create-media-upload.dto';
import { MediaParamsDto } from './dto/media-params.dto';
import {
  CreateMediaUploadResponseDto,
  MediaAssetResponseDto,
} from './dto/media-response.dto';
import { MediaService } from './media.service';

@ApiTags('media')
@ApiBearerAuth()
@Controller('media/uploads')
@UseInterceptors(NoStoreInterceptor)
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create or replay a signed Cloudinary media upload',
    description:
      'Append every returned field and the file to a multipart FormData request sent directly to the returned Cloudinary URL. The API secret is never returned.',
  })
  @ApiBody({
    type: CreateMediaUploadDto,
    examples: {
      default: {
        summary: 'Authorize a JPEG profile avatar upload',
        value: {
          clientUploadId: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
          purpose: 'profile_avatar',
          contentType: 'image/jpeg',
          sizeBytes: 245000,
          originalFilename: 'profile-photo.jpg',
        },
      },
      messageAttachment: {
        summary: 'Authorize a PNG chat image upload',
        value: {
          clientUploadId: '8e555951-aed1-42e2-a356-600edf85fae3',
          purpose: 'message_attachment',
          contentType: 'image/png',
          sizeBytes: 512000,
          originalFilename: 'chat-image.png',
        },
      },
      audioRecording: {
        summary: 'Authorize an M4A chat audio recording upload',
        value: {
          clientUploadId: '9f666062-bfe2-43f3-b467-711ef0960bf4',
          purpose: 'message_attachment',
          contentType: 'audio/mp4',
          sizeBytes: 1250000,
          originalFilename: 'voice-note.m4a',
        },
      },
    },
  })
  @ApiCreatedResponse({ type: CreateMediaUploadResponseDto })
  @ApiBadRequestResponse({ description: 'The upload request is invalid.' })
  @ApiConflictResponse({
    description:
      'The idempotency key conflicts with different data or is no longer reusable.',
  })
  @ApiGoneResponse({
    description: 'The existing upload authorization expired.',
  })
  @ApiPayloadTooLargeResponse({
    description: 'The declared media size exceeds its configured maximum.',
  })
  @ApiBadGatewayResponse({
    description: 'Cloudinary is temporarily unavailable.',
  })
  @ApiServiceUnavailableResponse({
    description:
      'Media uploads are disabled, or the audio upload preset is not configured.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateMediaUploadDto,
  ): Promise<CreateMediaUploadResponseDto> {
    return this.mediaService.createUpload(user.sub, input);
  }

  @Post(':mediaId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Verify a direct Cloudinary upload and mark it ready',
  })
  @ApiOkResponse({ type: MediaAssetResponseDto })
  @ApiBadRequestResponse({ description: 'The media ID is invalid.' })
  @ApiNotFoundResponse({
    description: 'The upload is missing or belongs to another user.',
  })
  @ApiConflictResponse({
    description:
      'The object is not available yet, does not match the signed request, or cannot be completed.',
  })
  @ApiGoneResponse({ description: 'The upload authorization expired.' })
  @ApiBadGatewayResponse({
    description: 'Cloudinary is temporarily unavailable.',
  })
  @ApiServiceUnavailableResponse({
    description: 'Media uploads are disabled on this server.',
  })
  complete(
    @CurrentUser() user: AuthenticatedUser,
    @Param() params: MediaParamsDto,
  ): Promise<MediaAssetResponseDto> {
    return this.mediaService.completeUpload(user.sub, params.mediaId);
  }
}

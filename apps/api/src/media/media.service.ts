import { createHash, randomUUID } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/errors/api.exception';
import type { UserResponseDto } from '../auth/dto/auth-response.dto';
import type {
  CreateMediaUploadDto,
  MediaUploadContentType,
  MediaUploadPurpose,
} from './dto/create-media-upload.dto';
import {
  isAudioUploadContentType,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
} from './dto/create-media-upload.dto';
import type {
  CreateMediaUploadResponseDto,
  MediaAssetResponseDto,
} from './dto/media-response.dto';
import { MediaClock } from './media-clock';
import { MediaRepository } from './media.repository';
import {
  MediaStorageError,
  MediaStorageProvider,
} from './media-storage.provider';
import type {
  MediaAssetRecord,
  MediaPurpose,
  MediaProfileUserRecord,
  StoredAudioResource,
  StoredImageResource,
} from './media.types';

const DEFAULT_UPLOAD_TTL_SECONDS = 600;
const DEFAULT_CLOUDINARY_FOLDER = 'chateo';
const DEFAULT_MAX_PROFILE_AVATAR_DIMENSION = 2048;
const DEFAULT_MAX_PROFILE_AVATAR_PIXELS = 4_194_304;
const DEFAULT_MAX_CHAT_AUDIO_BYTES = MAX_AUDIO_UPLOAD_BYTES;
const DEFAULT_MAX_CHAT_AUDIO_DURATION_MS = 15 * 60 * 1000;

interface NormalizedMediaUploadInput {
  clientUploadId: string;
  purpose: MediaUploadPurpose;
  contentType: MediaUploadContentType;
  sizeBytes: number;
  contentSha256: string | null;
  originalFilename: string | null;
}

interface VerifiedCompletionMetadata {
  cloudinaryAssetId: string;
  format: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  secureUrl: string;
  etag: string | null;
}

@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  constructor(
    private readonly repository: MediaRepository,
    private readonly storage: MediaStorageProvider,
    private readonly clock: MediaClock,
    private readonly config: ConfigService,
  ) {}

  async createUpload(
    userId: string,
    input: CreateMediaUploadDto,
  ): Promise<CreateMediaUploadResponseDto> {
    this.assertUploadsEnabled();
    const normalizedUserId = userId.toLowerCase();
    const normalizedInput = this.normalizeInput(input);
    this.assertPurposeSupportsContentType(normalizedInput);
    this.assertAllowedSize(normalizedInput);
    const resourceType = isAudioUploadContentType(normalizedInput.contentType)
      ? ('video' as const)
      : ('image' as const);

    const now = this.clock.now();
    const mediaId = randomUUID();
    const result = await this.repository.createPending({
      id: mediaId,
      ownerId: normalizedUserId,
      clientUploadId: normalizedInput.clientUploadId,
      purpose: this.toStoredPurpose(normalizedInput.purpose),
      uploadFingerprint: this.uploadFingerprint(normalizedInput),
      contentSha256: normalizedInput.contentSha256,
      cloudinaryPublicId: this.cloudinaryPublicId(
        mediaId,
        normalizedInput.purpose,
        resourceType,
      ),
      resourceType,
      deliveryType: 'upload',
      mimeType: normalizedInput.contentType,
      byteSize: normalizedInput.sizeBytes,
      originalFilename: normalizedInput.originalFilename,
      expiresAt: new Date(now.getTime() + this.uploadTtlSeconds() * 1000),
      now,
    });

    if (result.status === 'idempotency-conflict') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT',
        'The client upload ID has already been used with different upload data.',
      );
    }

    const asset = result.asset;
    if (asset.status === 'READY') {
      return { media: this.toResponse(asset), upload: null };
    }
    if (asset.status !== 'PENDING') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MEDIA_UPLOAD_NOT_REUSABLE',
        'This client upload ID belongs to an upload that cannot be retried.',
      );
    }
    this.assertNotExpired(asset, now);

    try {
      const signInput = {
        publicId: asset.cloudinaryPublicId,
        timestamp: asset.createdAt,
        context: this.storageContext(asset),
      };
      const upload =
        asset.resourceType === 'video'
          ? await this.storage.signAudioUpload(signInput)
          : await this.storage.signImageUpload(signInput);
      return {
        media: this.toResponse(asset),
        upload: {
          ...upload,
          expiresAt: asset.expiresAt.toISOString(),
        },
      };
    } catch (error) {
      throw this.mapStorageError(error);
    }
  }

  async completeUpload(
    userId: string,
    mediaId: string,
  ): Promise<MediaAssetResponseDto> {
    const normalizedUserId = userId.toLowerCase();
    const normalizedMediaId = mediaId.toLowerCase();
    const asset = await this.repository.findForOwner(
      normalizedMediaId,
      normalizedUserId,
    );
    if (!asset) throw this.notFoundException();
    if (asset.status === 'READY') return this.toResponse(asset);
    if (asset.status !== 'PENDING') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MEDIA_UPLOAD_NOT_COMPLETABLE',
        'This upload cannot be completed.',
      );
    }

    const now = this.clock.now();
    if (asset.expiresAt.getTime() <= now.getTime()) {
      await this.rejectUploadBestEffort(asset, now);
      this.assertNotExpired(asset, now);
    }

    let completion: VerifiedCompletionMetadata | null;
    try {
      if (asset.resourceType === 'video') {
        const resource = await this.storage.findAudio(asset.cloudinaryPublicId);
        if (!resource) throw this.uploadNotReadyException();
        completion = this.verifyAudioResource(asset, resource);
      } else {
        const resource = await this.storage.findImage(asset.cloudinaryPublicId);
        if (!resource) throw this.uploadNotReadyException();
        completion = this.verifyImageResource(asset, resource);
      }
    } catch (error) {
      if (error instanceof ApiException) throw error;
      throw this.mapStorageError(error);
    }

    const completionNow = this.clock.now();
    if (asset.expiresAt.getTime() <= completionNow.getTime()) {
      await this.rejectUploadBestEffort(asset, completionNow);
      throw this.uploadExpiredException();
    }

    if (!completion) {
      await this.rejectUploadBestEffort(asset, completionNow);
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MEDIA_UPLOAD_VERIFICATION_FAILED',
        'The uploaded resource does not match the signed upload request.',
      );
    }

    const result = await this.repository.completePending({
      id: asset.id,
      ownerId: asset.ownerId,
      ...completion,
      now: completionNow,
    });
    if (result.status === 'not-found') throw this.notFoundException();
    if (result.status === 'expired') {
      await this.rejectUploadBestEffort(result.asset, completionNow);
      throw this.uploadExpiredException();
    }
    if (result.status === 'not-pending') {
      if (result.asset.status === 'READY') {
        return this.toResponse(result.asset);
      }
      throw new ApiException(
        HttpStatus.CONFLICT,
        'MEDIA_UPLOAD_NOT_COMPLETABLE',
        'This upload cannot be completed.',
      );
    }
    return this.toResponse(result.asset);
  }

  async setProfileAvatar(
    userId: string,
    mediaId: string,
  ): Promise<UserResponseDto> {
    const result = await this.repository.setProfileAvatar(
      userId.toLowerCase(),
      mediaId.toLowerCase(),
    );
    if (result.status === 'media-not-found') throw this.notFoundException();
    if (result.status === 'media-not-ready') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'PROFILE_AVATAR_NOT_READY',
        'Complete this profile avatar upload before selecting it.',
      );
    }
    return this.toUserResponse(result.user);
  }

  async clearProfileAvatar(userId: string): Promise<void> {
    const user = await this.repository.clearProfileAvatar(userId.toLowerCase());
    if (!user) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'The signed-in user no longer exists.',
      );
    }
  }

  private normalizeInput(
    input: CreateMediaUploadDto,
  ): NormalizedMediaUploadInput {
    return {
      clientUploadId: input.clientUploadId.toLowerCase(),
      purpose: input.purpose,
      contentType: input.contentType,
      sizeBytes: input.sizeBytes,
      contentSha256: input.contentSha256?.toLowerCase() ?? null,
      originalFilename: input.originalFilename?.trim() || null,
    };
  }

  private assertAllowedSize(input: NormalizedMediaUploadInput): void {
    const isAudio = isAudioUploadContentType(input.contentType);
    const configuredMaximum = isAudio
      ? this.maxAudioBytes()
      : this.maxAvatarBytes();
    if (input.sizeBytes > configuredMaximum) {
      throw new ApiException(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'MEDIA_UPLOAD_TOO_LARGE',
        `${isAudio ? 'Audio' : 'Image'} uploads cannot exceed ${configuredMaximum} bytes.`,
        { maximumBytes: configuredMaximum },
      );
    }
  }

  private assertPurposeSupportsContentType(
    input: NormalizedMediaUploadInput,
  ): void {
    if (
      input.purpose === 'profile_avatar' &&
      isAudioUploadContentType(input.contentType)
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'MEDIA_UPLOAD_CONTENT_TYPE_UNSUPPORTED',
        'Profile avatars only support JPEG, PNG, or WebP images.',
      );
    }
  }

  private uploadTtlSeconds(): number {
    return this.config.get<number>(
      'MEDIA_UPLOAD_TTL_SECONDS',
      DEFAULT_UPLOAD_TTL_SECONDS,
    );
  }

  private cloudinaryPublicId(
    mediaId: string,
    purpose: MediaUploadPurpose,
    resourceType: 'image' | 'video',
  ): string {
    const folder = this.config.get<string>(
      'CLOUDINARY_UPLOAD_FOLDER',
      DEFAULT_CLOUDINARY_FOLDER,
    );
    const purposeFolder =
      purpose === 'profile_avatar'
        ? 'profile-avatars'
        : resourceType === 'video'
          ? 'message-audio'
          : 'message-images';
    return `${folder}/${purposeFolder}/${mediaId}`;
  }

  private uploadFingerprint(input: {
    purpose: string;
    contentType: string;
    sizeBytes: number;
    contentSha256: string | null;
    originalFilename: string | null;
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          input.purpose,
          input.contentType,
          input.sizeBytes,
          input.contentSha256,
          input.originalFilename,
        ]),
        'utf8',
      )
      .digest('hex');
  }

  private storageContext(asset: MediaAssetRecord): Record<string, string> {
    return {
      media_id: asset.id,
      upload_fingerprint: asset.uploadFingerprint,
    };
  }

  private verifyImageResource(
    asset: MediaAssetRecord,
    resource: StoredImageResource,
  ): VerifiedCompletionMetadata | null {
    const matches =
      asset.resourceType === 'image' &&
      resource.assetId.length > 0 &&
      resource.publicId === asset.cloudinaryPublicId &&
      resource.resourceType === 'image' &&
      resource.deliveryType === 'upload' &&
      resource.byteSize >= 1 &&
      resource.byteSize <= this.maxAvatarBytes() &&
      this.mimeTypeForFormat(resource.format) === asset.mimeType &&
      resource.context.media_id === asset.id &&
      resource.context.upload_fingerprint === asset.uploadFingerprint &&
      Number.isSafeInteger(resource.width) &&
      Number.isSafeInteger(resource.height) &&
      resource.width >= 1 &&
      resource.height >= 1 &&
      resource.width <= this.maxAvatarDimension() &&
      resource.height <= this.maxAvatarDimension() &&
      resource.width * resource.height <= this.maxAvatarPixels() &&
      this.isHttpsUrl(resource.secureUrl);
    return matches
      ? {
          cloudinaryAssetId: resource.assetId,
          format: resource.format.toLowerCase(),
          byteSize: resource.byteSize,
          width: resource.width,
          height: resource.height,
          durationMs: null,
          secureUrl: resource.secureUrl,
          etag: resource.etag,
        }
      : null;
  }

  private verifyAudioResource(
    asset: MediaAssetRecord,
    resource: StoredAudioResource,
  ): VerifiedCompletionMetadata | null {
    const durationMilliseconds = resource.durationSeconds * 1000;
    const roundedDurationMilliseconds = Math.round(durationMilliseconds);
    const matches =
      asset.resourceType === 'video' &&
      resource.assetId.length > 0 &&
      resource.publicId === asset.cloudinaryPublicId &&
      resource.resourceType === 'video' &&
      resource.deliveryType === 'upload' &&
      resource.byteSize >= 1 &&
      resource.byteSize <= this.maxAudioBytes() &&
      this.audioFormatMatchesMimeType(resource.format, asset.mimeType) &&
      resource.context.media_id === asset.id &&
      resource.context.upload_fingerprint === asset.uploadFingerprint &&
      Number.isFinite(durationMilliseconds) &&
      durationMilliseconds > 0 &&
      durationMilliseconds <= this.maxAudioDurationMs() &&
      Number.isSafeInteger(roundedDurationMilliseconds) &&
      roundedDurationMilliseconds >= 1 &&
      this.isHttpsUrl(resource.secureUrl);
    return matches
      ? {
          cloudinaryAssetId: resource.assetId,
          format: resource.format.toLowerCase(),
          byteSize: resource.byteSize,
          width: null,
          height: null,
          durationMs: roundedDurationMilliseconds,
          secureUrl: resource.secureUrl,
          etag: resource.etag,
        }
      : null;
  }

  private maxAvatarDimension(): number {
    return this.config.get<number>(
      'MEDIA_MAX_PROFILE_AVATAR_DIMENSION',
      DEFAULT_MAX_PROFILE_AVATAR_DIMENSION,
    );
  }

  private maxAvatarBytes(): number {
    return this.config.get<number>(
      'MEDIA_MAX_PROFILE_AVATAR_BYTES',
      MAX_IMAGE_UPLOAD_BYTES,
    );
  }

  private maxAudioBytes(): number {
    return this.config.get<number>(
      'MEDIA_MAX_CHAT_AUDIO_BYTES',
      DEFAULT_MAX_CHAT_AUDIO_BYTES,
    );
  }

  private maxAudioDurationMs(): number {
    return this.config.get<number>(
      'MEDIA_MAX_CHAT_AUDIO_DURATION_MS',
      DEFAULT_MAX_CHAT_AUDIO_DURATION_MS,
    );
  }

  private maxAvatarPixels(): number {
    return this.config.get<number>(
      'MEDIA_MAX_PROFILE_AVATAR_PIXELS',
      DEFAULT_MAX_PROFILE_AVATAR_PIXELS,
    );
  }

  private async rejectUploadBestEffort(
    asset: MediaAssetRecord,
    now: Date,
  ): Promise<void> {
    try {
      await this.repository.failPending(asset.id, asset.ownerId, now);
    } catch (error) {
      this.logCleanupError('mark rejected', asset.id, error);
    }
  }

  private logCleanupError(
    action: string,
    mediaId: string,
    error: unknown,
  ): void {
    this.logger.warn(
      `Failed to ${action} for media ${mediaId}`,
      error instanceof Error ? error.stack : undefined,
    );
  }

  private mimeTypeForFormat(format: string): string | null {
    switch (format.toLowerCase()) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'webp':
        return 'image/webp';
      default:
        return null;
    }
  }

  private audioFormatMatchesMimeType(
    format: string,
    mimeType: string,
  ): boolean {
    switch (mimeType) {
      case 'audio/aac':
        return format.toLowerCase() === 'aac';
      case 'audio/mp4':
      case 'audio/m4a':
      case 'audio/x-m4a':
        return format.toLowerCase() === 'm4a';
      case 'audio/mpeg':
        return format.toLowerCase() === 'mp3';
      case 'audio/ogg':
        return format.toLowerCase() === 'ogg';
      case 'audio/wav':
      case 'audio/x-wav':
        return format.toLowerCase() === 'wav';
      default:
        return false;
    }
  }

  private isHttpsUrl(value: string): boolean {
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }

  private assertNotExpired(asset: MediaAssetRecord, now: Date): void {
    if (asset.expiresAt.getTime() <= now.getTime()) {
      throw this.uploadExpiredException();
    }
  }

  private assertUploadsEnabled(): void {
    if (!this.config.get<boolean>('MEDIA_UPLOADS_ENABLED', false)) {
      throw this.uploadsDisabledException();
    }
  }

  private uploadExpiredException(): ApiException {
    return new ApiException(
      HttpStatus.GONE,
      'MEDIA_UPLOAD_EXPIRED',
      'The upload authorization has expired. Start a new upload with a new client upload ID.',
    );
  }

  private uploadsDisabledException(): ApiException {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'MEDIA_UPLOADS_DISABLED',
      'Media uploads are not configured on this server.',
    );
  }

  private audioUploadsDisabledException(): ApiException {
    return new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'MEDIA_AUDIO_UPLOADS_DISABLED',
      'Chat audio uploads are not configured on this server.',
    );
  }

  private uploadNotReadyException(): ApiException {
    return new ApiException(
      HttpStatus.CONFLICT,
      'MEDIA_UPLOAD_NOT_READY',
      'Cloudinary has not received this upload yet.',
    );
  }

  private mapStorageError(error: unknown): ApiException {
    if (
      error instanceof MediaStorageError &&
      error.reason === 'not-configured'
    ) {
      return this.uploadsDisabledException();
    }
    if (
      error instanceof MediaStorageError &&
      error.reason === 'audio-not-configured'
    ) {
      return this.audioUploadsDisabledException();
    }
    return new ApiException(
      HttpStatus.BAD_GATEWAY,
      'MEDIA_STORAGE_UNAVAILABLE',
      'The media storage provider is temporarily unavailable.',
    );
  }

  private notFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'MEDIA_UPLOAD_NOT_FOUND',
      'The media upload was not found.',
    );
  }

  private toResponse(asset: MediaAssetRecord): MediaAssetResponseDto {
    return {
      id: asset.id,
      purpose: this.toApiPurpose(asset.purpose),
      status: asset.status.toLowerCase() as MediaAssetResponseDto['status'],
      type: asset.resourceType === 'video' ? 'audio' : 'image',
      contentType: asset.mimeType,
      sizeBytes: asset.byteSize,
      originalFilename: asset.originalFilename,
      width: asset.width,
      height: asset.height,
      durationMs: asset.durationMs,
      secureUrl: asset.secureUrl,
      createdAt: asset.createdAt.toISOString(),
      expiresAt: asset.expiresAt.toISOString(),
      completedAt: asset.completedAt?.toISOString() ?? null,
    };
  }

  private toStoredPurpose(purpose: MediaUploadPurpose): MediaPurpose {
    return purpose === 'profile_avatar'
      ? 'PROFILE_AVATAR'
      : 'MESSAGE_ATTACHMENT';
  }

  private toApiPurpose(
    purpose: MediaPurpose,
  ): MediaAssetResponseDto['purpose'] {
    return purpose === 'PROFILE_AVATAR'
      ? 'profile_avatar'
      : 'message_attachment';
  }

  private toUserResponse(user: MediaProfileUserRecord): UserResponseDto {
    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileComplete: user.profileCompletedAt !== null,
      createdAt: user.createdAt.toISOString(),
    };
  }
}

import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  Validate,
  ValidatorConstraint,
  type ValidationArguments,
  type ValidatorConstraintInterface,
} from 'class-validator';
import { IsPostgresText } from '../../messages/validators/is-postgres-text.decorator';
import {
  DOCUMENT_FORMAT_BY_MIME,
  VIDEO_FORMAT_BY_MIME,
  MAX_VIDEO_UPLOAD_BYTES,
  MAX_DOCUMENT_UPLOAD_BYTES,
  mediaType,
} from '../attachment-formats';

export const MAX_IMAGE_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_AUDIO_UPLOAD_BYTES = 20 * 1024 * 1024;
export const IMAGE_UPLOAD_CONTENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;
export const AUDIO_UPLOAD_CONTENT_TYPES = [
  'audio/aac',
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'audio/x-wav',
] as const;
export const MEDIA_UPLOAD_CONTENT_TYPES = [
  ...IMAGE_UPLOAD_CONTENT_TYPES,
  ...AUDIO_UPLOAD_CONTENT_TYPES,
  ...(Object.keys(VIDEO_FORMAT_BY_MIME) as Array<
    keyof typeof VIDEO_FORMAT_BY_MIME
  >),
  ...(Object.keys(DOCUMENT_FORMAT_BY_MIME) as Array<
    keyof typeof DOCUMENT_FORMAT_BY_MIME
  >),
] as const;
export const MEDIA_UPLOAD_PURPOSES = [
  'profile_avatar',
  'group_avatar',
  'message_attachment',
] as const;
export type MediaUploadPurpose = (typeof MEDIA_UPLOAD_PURPOSES)[number];
export type MediaUploadContentType =
  (typeof MEDIA_UPLOAD_CONTENT_TYPES)[number];

export function isAudioUploadContentType(
  value: string,
): value is (typeof AUDIO_UPLOAD_CONTENT_TYPES)[number] {
  return (AUDIO_UPLOAD_CONTENT_TYPES as readonly string[]).includes(value);
}

@ValidatorConstraint({ name: 'mediaPurposeSupportsContentType' })
class MediaPurposeSupportsContentTypeConstraint
  implements ValidatorConstraintInterface
{
  validate(value: unknown, args: ValidationArguments): boolean {
    if (!MEDIA_UPLOAD_PURPOSES.includes(value as MediaUploadPurpose)) {
      return true;
    }
    const input = args.object as Partial<CreateMediaUploadDto>;
    if (
      typeof input.contentType !== 'string' ||
      !MEDIA_UPLOAD_CONTENT_TYPES.includes(
        input.contentType as MediaUploadContentType,
      )
    ) {
      return true;
    }
    return (
      value === 'message_attachment' || mediaType(input.contentType) === 'image'
    );
  }

  defaultMessage(): string {
    return 'Avatar uploads only support JPEG, PNG, or WebP images';
  }
}

@ValidatorConstraint({ name: 'mediaUploadSize' })
class MediaUploadSizeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (!Number.isInteger(value)) return true;
    const input = args.object as Partial<CreateMediaUploadDto>;
    const maximum = this.maximum(input.contentType);
    return (value as number) <= maximum;
  }

  defaultMessage(args: ValidationArguments): string {
    const input = args.object as Partial<CreateMediaUploadDto>;
    return `sizeBytes must not be greater than ${this.maximum(input.contentType)} for this upload type`;
  }

  private maximum(contentType?: string): number {
    const type = mediaType(contentType ?? '');
    return type === 'video'
      ? MAX_VIDEO_UPLOAD_BYTES
      : type === 'document'
        ? MAX_DOCUMENT_UPLOAD_BYTES
        : type === 'audio'
          ? MAX_AUDIO_UPLOAD_BYTES
          : MAX_IMAGE_UPLOAD_BYTES;
  }
}

export class CreateMediaUploadDto {
  @ApiProperty({
    format: 'uuid',
    example: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
    description:
      'A client-generated idempotency key. Reuse it only when retrying the same upload request.',
  })
  @IsUUID()
  clientUploadId!: string;

  @ApiProperty({
    enum: MEDIA_UPLOAD_PURPOSES,
    example: 'profile_avatar',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(MEDIA_UPLOAD_PURPOSES)
  @Validate(MediaPurposeSupportsContentTypeConstraint)
  purpose!: MediaUploadPurpose;

  @ApiProperty({
    enum: MEDIA_UPLOAD_CONTENT_TYPES,
    example: 'image/jpeg',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsIn(MEDIA_UPLOAD_CONTENT_TYPES)
  contentType!: MediaUploadContentType;

  @ApiProperty({
    minimum: 1,
    maximum: MAX_VIDEO_UPLOAD_BYTES,
    example: 245000,
    description:
      'Declared size: images 5 MiB, audio 20 MiB, video 50 MiB, documents 25 MiB, before configured limits are applied.',
  })
  @IsInt()
  @Min(1)
  @Validate(MediaUploadSizeConstraint)
  sizeBytes!: number;

  @ApiPropertyOptional({
    pattern: '^[0-9a-f]{64}$',
    example: 'a'.repeat(64),
    description:
      'Optional client-calculated SHA-256 strengthens idempotency. Document completion additionally verifies it against downloaded bytes; image/audio/video metadata does not independently verify it.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  contentSha256?: string;

  @ApiPropertyOptional({
    maxLength: 255,
    example: 'profile-photo.jpg',
    description:
      'Display metadata only; never used as the Cloudinary public ID.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @IsPostgresText(255)
  originalFilename?: string;
}

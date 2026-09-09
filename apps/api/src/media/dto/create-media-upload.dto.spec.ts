import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  AUDIO_UPLOAD_CONTENT_TYPES,
  CreateMediaUploadDto,
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_IMAGE_UPLOAD_BYTES,
} from './create-media-upload.dto';

const CLIENT_UPLOAD_ID = '33333333-3333-4333-8333-333333333333';

function input(overrides: Record<string, unknown> = {}): CreateMediaUploadDto {
  return plainToInstance(CreateMediaUploadDto, {
    clientUploadId: CLIENT_UPLOAD_ID,
    purpose: 'profile_avatar',
    contentType: 'image/jpeg',
    sizeBytes: 245000,
    ...overrides,
  });
}

describe('CreateMediaUploadDto', () => {
  it.each(['profile_avatar', 'message_attachment'] as const)(
    'accepts the supported %s image purpose',
    async (purpose) => {
      await expect(validate(input({ purpose }))).resolves.toEqual([]);
    },
  );

  it('normalizes the message attachment purpose and image MIME type', async () => {
    const transformed = input({
      purpose: '  MESSAGE_ATTACHMENT  ',
      contentType: '  IMAGE/WEBP  ',
    });

    await expect(validate(transformed)).resolves.toEqual([]);
    expect(transformed).toMatchObject({
      purpose: 'message_attachment',
      contentType: 'image/webp',
    });
  });

  it.each(['group_avatar', 'audio_recording', 'message_video'])(
    'rejects unsupported purpose %s',
    async (purpose) => {
      const errors = await validate(input({ purpose }));

      expect(errors.some((error) => error.property === 'purpose')).toBe(true);
    },
  );

  it.each(AUDIO_UPLOAD_CONTENT_TYPES)(
    'accepts supported chat audio MIME type %s',
    async (contentType) => {
      await expect(
        validate(
          input({
            purpose: 'message_attachment',
            contentType,
            sizeBytes: MAX_AUDIO_UPLOAD_BYTES,
          }),
        ),
      ).resolves.toEqual([]);
    },
  );

  it('rejects audio when the purpose is profile_avatar', async () => {
    const errors = await validate(
      input({ purpose: 'profile_avatar', contentType: 'audio/mp4' }),
    );

    expect(errors.some((error) => error.property === 'purpose')).toBe(true);
  });

  it('retains the five MiB image limit', async () => {
    const errors = await validate(
      input({
        purpose: 'message_attachment',
        sizeBytes: MAX_IMAGE_UPLOAD_BYTES + 1,
      }),
    );

    expect(errors.some((error) => error.property === 'sizeBytes')).toBe(true);
  });

  it('allows audio above five MiB but rejects audio above twenty MiB', async () => {
    await expect(
      validate(
        input({
          purpose: 'message_attachment',
          contentType: 'audio/mpeg',
          sizeBytes: MAX_IMAGE_UPLOAD_BYTES + 1,
        }),
      ),
    ).resolves.toEqual([]);

    const errors = await validate(
      input({
        purpose: 'message_attachment',
        contentType: 'audio/mpeg',
        sizeBytes: MAX_AUDIO_UPLOAD_BYTES + 1,
      }),
    );
    expect(errors.some((error) => error.property === 'sizeBytes')).toBe(true);
  });
});

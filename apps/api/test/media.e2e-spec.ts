import {
  HttpStatus,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthController } from '../src/auth/auth.controller';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthService } from '../src/auth/auth.service';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AccessTokenService } from '../src/auth/providers/access-token.service';
import { Clock } from '../src/auth/providers/clock';
import { OtpCodeService } from '../src/auth/providers/otp-code.service';
import { OtpDeliveryProvider } from '../src/auth/providers/otp-delivery.provider';
import { PhoneNumberService } from '../src/auth/providers/phone-number.service';
import { RefreshTokenService } from '../src/auth/providers/refresh-token.service';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { NoStoreInterceptor } from '../src/common/no-store.interceptor';
import { validateEnvironment } from '../src/config/environment';
import { MediaClock } from '../src/media/media-clock';
import { MediaController } from '../src/media/media.controller';
import {
  MediaRepository,
  type CompletePendingMediaInput,
  type CreatePendingMediaInput,
} from '../src/media/media.repository';
import { MediaService } from '../src/media/media.service';
import {
  MediaStorageError,
  MediaStorageProvider,
  type SignAudioUploadInput,
  type SignImageUploadInput,
} from '../src/media/media-storage.provider';
import type {
  CompletePendingMediaResult,
  CreatePendingMediaResult,
  MediaAssetRecord,
  MediaProfileUserRecord,
  SetProfileAvatarResult,
  SignedAudioUpload,
  SignedImageUpload,
  StoredAudioResource,
  StoredImageResource,
  StoredVideoResource,
  StoredDocumentResource,
  SignedFileUpload,
} from '../src/media/media.types';
import { ProfileAvatarController } from '../src/media/profile-avatar.controller';
import {
  InMemoryAuthRepository,
  InspectableOtpDeliveryProvider,
  ManualClock,
} from './support/auth-test-doubles';

interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: unknown;
  path: string;
}

interface AuthBody {
  accessToken: string;
  user: {
    id: string;
    phoneNumber: string;
    displayName: string | null;
    avatarUrl: string | null;
    profileComplete: boolean;
    createdAt: string;
  };
}

interface CreateUploadBody {
  media: {
    id: string;
    purpose: 'profile_avatar' | 'group_avatar' | 'message_attachment';
    status: 'pending' | 'ready' | 'failed' | 'deleted';
    type: 'image' | 'audio' | 'video' | 'document';
    contentType: string;
    sizeBytes: number;
    originalFilename: string | null;
    width: number | null;
    height: number | null;
    durationMs: number | null;
    secureUrl: string | null;
    createdAt: string;
    expiresAt: string;
    completedAt: string | null;
  };
  upload: (SignedImageUpload | SignedAudioUpload | SignedFileUpload) & {
    expiresAt: string;
  };
}

const PHONE_NUMBER = '+14155552671';
const TEST_OTP = '2468';
const NOW = new Date('2026-09-06T10:00:00.000Z');
const CLIENT_UPLOAD_ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN_USER_ID = '99999999-9999-4999-8999-999999999999';
const API_SECRET_SENTINEL = 'this-must-never-leave-the-server';
const MEDIA_ENVIRONMENT = {
  MEDIA_UPLOADS_ENABLED: process.env.MEDIA_UPLOADS_ENABLED,
  CLOUDINARY_CLOUD_NAME: process.env.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: process.env.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: process.env.CLOUDINARY_API_SECRET,
  CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET:
    process.env.CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET,
  CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET:
    process.env.CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET,
};

function copyDate(value: Date): Date {
  return new Date(value.getTime());
}

function copyNullableDate(value: Date | null): Date | null {
  return value ? copyDate(value) : null;
}

function copyAsset(record: MediaAssetRecord): MediaAssetRecord {
  return {
    ...record,
    expiresAt: copyDate(record.expiresAt),
    completedAt: copyNullableDate(record.completedAt),
    failedAt: copyNullableDate(record.failedAt),
    deletedAt: copyNullableDate(record.deletedAt),
    createdAt: copyDate(record.createdAt),
    updatedAt: copyDate(record.updatedAt),
  };
}

function copyUser(record: MediaProfileUserRecord): MediaProfileUserRecord {
  return {
    ...record,
    profileCompletedAt: copyNullableDate(record.profileCompletedAt),
    createdAt: copyDate(record.createdAt),
  };
}

class InMemoryMediaRepository extends MediaRepository {
  private readonly assets = new Map<string, MediaAssetRecord>();
  private readonly assetIdsByClientKey = new Map<string, string>();
  private readonly users = new Map<string, MediaProfileUserRecord>();

  seedUser(record: MediaProfileUserRecord): void {
    this.users.set(record.id.toLowerCase(), copyUser(record));
  }

  seedAsset(record: MediaAssetRecord): void {
    const copy = copyAsset(record);
    this.assets.set(copy.id.toLowerCase(), copy);
    this.assetIdsByClientKey.set(
      this.clientKey(copy.ownerId, copy.clientUploadId),
      copy.id.toLowerCase(),
    );
  }

  findByClientUpload(
    ownerId: string,
    clientUploadId: string,
  ): MediaAssetRecord | null {
    const id = this.assetIdsByClientKey.get(
      this.clientKey(ownerId, clientUploadId),
    );
    const record = id ? this.assets.get(id) : undefined;
    return record ? copyAsset(record) : null;
  }

  inspectUser(id: string): MediaProfileUserRecord | null {
    const record = this.users.get(id.toLowerCase());
    return record ? copyUser(record) : null;
  }

  override async createPending(
    input: CreatePendingMediaInput,
  ): Promise<CreatePendingMediaResult> {
    const clientKey = this.clientKey(input.ownerId, input.clientUploadId);
    const existingId = this.assetIdsByClientKey.get(clientKey);
    const existing = existingId ? this.assets.get(existingId) : undefined;
    if (existing) {
      return existing.uploadFingerprint === input.uploadFingerprint
        ? { status: 'existing', asset: copyAsset(existing) }
        : { status: 'idempotency-conflict' };
    }

    const record: MediaAssetRecord = {
      id: input.id.toLowerCase(),
      ownerId: input.ownerId.toLowerCase(),
      clientUploadId: input.clientUploadId.toLowerCase(),
      purpose: input.purpose,
      status: 'PENDING',
      uploadFingerprint: input.uploadFingerprint,
      contentSha256: input.contentSha256,
      cloudinaryPublicId: input.cloudinaryPublicId,
      cloudinaryAssetId: null,
      resourceType: input.resourceType,
      deliveryType: input.deliveryType,
      format: null,
      mimeType: input.mimeType,
      byteSize: input.byteSize,
      width: null,
      height: null,
      durationMs: null,
      originalFilename: input.originalFilename,
      secureUrl: null,
      etag: null,
      expiresAt: copyDate(input.expiresAt),
      completedAt: null,
      failedAt: null,
      deletedAt: null,
      createdAt: copyDate(input.now),
      updatedAt: copyDate(input.now),
    };
    this.assets.set(record.id, record);
    this.assetIdsByClientKey.set(clientKey, record.id);
    return { status: 'created', asset: copyAsset(record) };
  }

  override async findForOwner(
    id: string,
    ownerId: string,
  ): Promise<MediaAssetRecord | null> {
    const record = this.assets.get(id.toLowerCase());
    return record && record.ownerId === ownerId.toLowerCase()
      ? copyAsset(record)
      : null;
  }

  override async completePending(
    input: CompletePendingMediaInput,
  ): Promise<CompletePendingMediaResult> {
    const record = this.assets.get(input.id.toLowerCase());
    if (!record || record.ownerId !== input.ownerId.toLowerCase()) {
      return { status: 'not-found' };
    }
    if (record.status !== 'PENDING') {
      return { status: 'not-pending', asset: copyAsset(record) };
    }
    if (record.expiresAt.getTime() <= input.now.getTime()) {
      return { status: 'expired', asset: copyAsset(record) };
    }
    Object.assign(record, {
      status: 'READY' as const,
      cloudinaryAssetId: input.cloudinaryAssetId,
      format: input.format,
      byteSize: input.byteSize,
      width: input.width,
      height: input.height,
      durationMs: input.durationMs,
      secureUrl: input.secureUrl,
      etag: input.etag,
      completedAt: copyDate(input.now),
      updatedAt: copyDate(input.now),
    });
    return { status: 'ready', asset: copyAsset(record) };
  }

  override async failPending(
    id: string,
    ownerId: string,
    now: Date,
  ): Promise<boolean> {
    const record = this.assets.get(id.toLowerCase());
    if (
      record?.ownerId === ownerId.toLowerCase() &&
      record.status === 'PENDING'
    ) {
      record.status = 'FAILED';
      record.failedAt = copyDate(now);
      record.updatedAt = copyDate(now);
      return true;
    }
    return false;
  }

  override async setProfileAvatar(
    ownerId: string,
    mediaId: string,
  ): Promise<SetProfileAvatarResult> {
    const normalizedOwnerId = ownerId.toLowerCase();
    const asset = this.assets.get(mediaId.toLowerCase());
    if (
      !asset ||
      asset.ownerId !== normalizedOwnerId ||
      asset.purpose !== 'PROFILE_AVATAR'
    ) {
      return { status: 'media-not-found' };
    }
    if (asset.status !== 'READY' || !asset.secureUrl) {
      return { status: 'media-not-ready' };
    }
    const user = this.users.get(normalizedOwnerId);
    if (!user) throw new Error('The media test user is missing.');
    user.avatarUrl = asset.secureUrl;
    return { status: 'updated', user: copyUser(user) };
  }

  override async clearProfileAvatar(
    ownerId: string,
  ): Promise<MediaProfileUserRecord | null> {
    const user = this.users.get(ownerId.toLowerCase());
    if (!user) return null;
    user.avatarUrl = null;
    return copyUser(user);
  }

  private clientKey(ownerId: string, clientUploadId: string): string {
    return `${ownerId.toLowerCase()}:${clientUploadId.toLowerCase()}`;
  }
}

class MutableMediaClock extends MediaClock {
  private current = copyDate(NOW);

  override now(): Date {
    return copyDate(this.current);
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

class FakeMediaStorageProvider extends MediaStorageProvider {
  readonly videoResources = new Map<string, StoredVideoResource>();
  readonly documentResources = new Map<string, StoredDocumentResource>();
  documentContentValid = true;

  async signVideoUpload(
    input: SignImageUploadInput,
  ): Promise<SignedFileUpload> {
    const base = await this.signAudioUpload(input);
    return {
      ...base,
      fields: {
        ...base.fields,
        allowed_formats: 'mp4,mov,webm',
        upload_preset: 'chateo_chat_video',
      },
    };
  }
  async signDocumentUpload(
    input: SignImageUploadInput,
  ): Promise<SignedFileUpload> {
    const base = await this.signAudioUpload(input);
    return {
      ...base,
      url: base.url.replace('/video/', '/raw/'),
      fields: {
        ...base.fields,
        allowed_formats: 'pdf,txt,docx,xlsx,pptx',
        upload_preset: 'chateo_chat_documents',
      },
    };
  }
  async findVideo(publicId: string): Promise<StoredVideoResource | null> {
    return this.videoResources.get(publicId) ?? null;
  }
  async findDocument(publicId: string): Promise<StoredDocumentResource | null> {
    return this.documentResources.get(publicId) ?? null;
  }
  async verifyDocumentContent(): Promise<boolean> {
    return this.documentContentValid;
  }
  async deleteDocument(): Promise<void> {}
  readonly signCalls: SignImageUploadInput[] = [];
  readonly signAudioCalls: SignAudioUploadInput[] = [];
  readonly findCalls: string[] = [];
  readonly findAudioCalls: string[] = [];
  readonly deleteCalls: string[] = [];
  readonly deleteAudioCalls: string[] = [];
  signError: unknown = null;
  findError: unknown = null;
  private readonly imageResources = new Map<string, StoredImageResource>();
  private readonly audioResources = new Map<string, StoredAudioResource>();

  seedImage(record: StoredImageResource): void {
    this.imageResources.set(record.publicId, {
      ...record,
      context: { ...record.context },
    });
  }

  seedAudio(record: StoredAudioResource): void {
    this.audioResources.set(record.publicId, {
      ...record,
      context: { ...record.context },
    });
  }

  override async signImageUpload(
    input: SignImageUploadInput,
  ): Promise<SignedImageUpload> {
    this.signCalls.push({
      ...input,
      timestamp: copyDate(input.timestamp),
      context: { ...input.context },
    });
    if (this.signError) throw this.signError;
    const context = Object.entries(input.context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('|');
    return {
      url: 'https://api.cloudinary.com/v1_1/classroom/image/upload',
      method: 'POST',
      fields: {
        api_key: 'safe-public-key',
        timestamp: Math.floor(input.timestamp.getTime() / 1000).toString(),
        signature: 'short-lived-signature',
        public_id: input.publicId,
        context,
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'jpg,jpeg,png,webp',
        upload_preset: 'chateo_profile_avatars',
        transformation: 'c_limit,h_2048,w_2048/q_auto',
      },
    };
  }

  override async signAudioUpload(
    input: SignAudioUploadInput,
  ): Promise<SignedAudioUpload> {
    this.signAudioCalls.push({
      ...input,
      timestamp: copyDate(input.timestamp),
      context: { ...input.context },
    });
    if (this.signError) throw this.signError;
    const context = Object.entries(input.context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('|');
    return {
      url: 'https://api.cloudinary.com/v1_1/classroom/video/upload',
      method: 'POST',
      fields: {
        api_key: 'safe-public-key',
        timestamp: Math.floor(input.timestamp.getTime() / 1000).toString(),
        signature: 'short-lived-signature',
        public_id: input.publicId,
        context,
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'aac,m4a,mp3,ogg,wav',
        upload_preset: 'chateo_chat_audio',
      },
    };
  }

  override async findImage(
    publicId: string,
  ): Promise<StoredImageResource | null> {
    this.findCalls.push(publicId);
    if (this.findError) throw this.findError;
    const record = this.imageResources.get(publicId);
    return record ? { ...record, context: { ...record.context } } : null;
  }

  override async findAudio(
    publicId: string,
  ): Promise<StoredAudioResource | null> {
    this.findAudioCalls.push(publicId);
    if (this.findError) throw this.findError;
    const record = this.audioResources.get(publicId);
    return record ? { ...record, context: { ...record.context } } : null;
  }

  override async deleteImage(publicId: string): Promise<void> {
    this.deleteCalls.push(publicId);
    this.imageResources.delete(publicId);
  }

  override async deleteAudio(publicId: string): Promise<void> {
    this.deleteAudioCalls.push(publicId);
    this.audioResources.delete(publicId);
  }
}

function createStoredImage(
  asset: MediaAssetRecord,
  overrides: Partial<StoredImageResource> = {},
): StoredImageResource {
  return {
    assetId: `cloudinary-${asset.id}`,
    publicId: asset.cloudinaryPublicId,
    resourceType: 'image',
    deliveryType: 'upload',
    format:
      asset.mimeType === 'image/png'
        ? 'png'
        : asset.mimeType === 'image/webp'
          ? 'webp'
          : 'jpg',
    byteSize: asset.byteSize,
    width: 640,
    height: 480,
    secureUrl: `https://res.cloudinary.com/classroom/image/upload/${asset.id}.jpg`,
    etag: 'provider-etag',
    context: {
      media_id: asset.id,
      upload_fingerprint: asset.uploadFingerprint,
    },
    ...overrides,
  };
}

function createStoredAudio(
  asset: MediaAssetRecord,
  overrides: Partial<StoredAudioResource> = {},
): StoredAudioResource {
  return {
    assetId: `cloudinary-${asset.id}`,
    publicId: asset.cloudinaryPublicId,
    resourceType: 'video',
    deliveryType: 'upload',
    format: 'm4a',
    byteSize: asset.byteSize,
    durationSeconds: 42.125,
    secureUrl: `https://res.cloudinary.com/classroom/video/upload/${asset.id}.m4a`,
    etag: 'provider-audio-etag',
    context: {
      media_id: asset.id,
      upload_fingerprint: asset.uploadFingerprint,
    },
    ...overrides,
  };
}

function validUploadInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clientUploadId: CLIENT_UPLOAD_ID,
    purpose: 'profile_avatar',
    contentType: 'image/jpeg',
    sizeBytes: 245000,
    contentSha256: 'a'.repeat(64),
    originalFilename: 'profile-photo.jpg',
    ...overrides,
  };
}

describe('Media API (e2e, in memory)', () => {
  let app: INestApplication;
  let authRepository: InMemoryAuthRepository;
  let authClock: ManualClock;
  let mediaClock: MutableMediaClock;
  let mediaRepository: InMemoryMediaRepository;
  let storage: FakeMediaStorageProvider;
  let accessToken: string;
  let userId: string;

  beforeEach(async () => {
    process.env.MEDIA_UPLOADS_ENABLED = 'true';
    process.env.CLOUDINARY_CLOUD_NAME = 'classroom';
    process.env.CLOUDINARY_API_KEY = 'safe-public-key';
    process.env.CLOUDINARY_API_SECRET = API_SECRET_SENTINEL;
    process.env.CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET =
      'chateo_profile_avatars';
    process.env.CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET = 'chateo_chat_audio';
    authRepository = new InMemoryAuthRepository();
    authClock = new ManualClock(NOW);
    mediaClock = new MutableMediaClock();
    mediaRepository = new InMemoryMediaRepository();
    storage = new FakeMediaStorageProvider();
    const otpDelivery = new InspectableOtpDeliveryProvider();

    const moduleFixture = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          cache: true,
          isGlobal: true,
          validate: validateEnvironment,
        }),
        JwtModule.registerAsync({
          global: true,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => ({
            secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
            signOptions: {
              audience: 'chateo-mobile',
              expiresIn: config.get<number>(
                'AUTH_ACCESS_TOKEN_TTL_SECONDS',
                900,
              ),
              issuer: 'chateo-api',
            },
            verifyOptions: {
              audience: 'chateo-mobile',
              issuer: 'chateo-api',
            },
          }),
        }),
      ],
      controllers: [AuthController, MediaController, ProfileAvatarController],
      providers: [
        AuthService,
        { provide: AuthRepository, useValue: authRepository },
        { provide: Clock, useValue: authClock },
        { provide: OtpDeliveryProvider, useValue: otpDelivery },
        PhoneNumberService,
        OtpCodeService,
        RefreshTokenService,
        AccessTokenService,
        MediaService,
        { provide: MediaRepository, useValue: mediaRepository },
        { provide: MediaStorageProvider, useValue: storage },
        { provide: MediaClock, useValue: mediaClock },
        NoStoreInterceptor,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        forbidNonWhitelisted: true,
        transform: true,
        whitelist: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();

    const challengeResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/request')
      .send({ phoneNumber: PHONE_NUMBER })
      .expect(HttpStatus.ACCEPTED);
    const challengeId = (challengeResponse.body as { challengeId: string })
      .challengeId;
    const authResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .send({ challengeId, code: TEST_OTP })
      .expect(HttpStatus.OK);
    const auth = authResponse.body as AuthBody;
    accessToken = auth.accessToken;
    userId = auth.user.id;
    mediaRepository.seedUser({
      id: userId,
      phoneNumber: auth.user.phoneNumber,
      displayName: auth.user.displayName,
      avatarUrl: auth.user.avatarUrl,
      profileCompletedAt: auth.user.profileComplete ? NOW : null,
      createdAt: new Date(auth.user.createdAt),
    });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(MEDIA_ENVIRONMENT)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function authorized<T extends request.Test>(test: T): T {
    return test.set('Authorization', `Bearer ${accessToken}`) as T;
  }

  async function createUpload(
    input = validUploadInput(),
  ): Promise<CreateUploadBody> {
    const response = await authorized(
      request(app.getHttpServer()).post('/v1/media/uploads'),
    )
      .send(input)
      .expect(HttpStatus.CREATED);
    return response.body as CreateUploadBody;
  }

  it.each([
    ['video/mp4', 'mp4'],
    ['video/quicktime', 'mov'],
    ['video/webm', 'webm'],
  ])(
    'signs and verifies a %s video with dimensions and duration',
    async (contentType, format) => {
      const input = validUploadInput({
        purpose: 'message_attachment',
        contentType,
        sizeBytes: 2000000,
      });
      const created = await createUpload(input);
      expect(created.media).toMatchObject({ type: 'video', status: 'pending' });
      expect(created.upload.fields).toMatchObject({
        allowed_formats: 'mp4,mov,webm',
        overwrite: 'false',
        upload_preset: 'chateo_chat_video',
      });
      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      )!;
      storage.videoResources.set(pending.cloudinaryPublicId, {
        ...createStoredAudio(pending, { format, durationSeconds: 15.25 }),
        width: 1280,
        height: 720,
        videoCodec: 'h264',
      });
      const completed = await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(200);
      expect(completed.body).toMatchObject({
        type: 'video',
        status: 'ready',
        contentType,
        width: 1280,
        height: 720,
        durationMs: 15250,
      });
      expect((await createUpload(input)).media).toMatchObject({
        id: created.media.id,
        status: 'ready',
      });
    },
  );

  it.each([
    ['application/pdf', 'pdf'],
    ['text/plain', 'txt'],
    [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'docx',
    ],
    [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'xlsx',
    ],
    [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'pptx',
    ],
  ])(
    'signs and verifies %s documents using raw storage and server-selected extensions',
    async (contentType, format) => {
      const created = await createUpload(
        validUploadInput({
          purpose: 'message_attachment',
          contentType,
          originalFilename: 'class/lesson.exe',
          sizeBytes: 12000,
        }),
      );
      expect(created.media).toMatchObject({
        type: 'document',
        originalFilename: `class_lesson.${format}`,
      });
      expect(created.upload.url).toContain('/raw/upload');
      expect(created.upload.fields).toMatchObject({
        allowed_formats: 'pdf,txt,docx,xlsx,pptx',
        overwrite: 'false',
      });
      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      )!;
      expect(pending.cloudinaryPublicId.endsWith(`.${format}`)).toBe(true);
      storage.documentResources.set(pending.cloudinaryPublicId, {
        ...createStoredImage(pending),
        resourceType: 'raw',
        format,
        secureUrl: `https://res.cloudinary.com/classroom/raw/upload/${pending.cloudinaryPublicId}`,
      });
      const completed = await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(200);
      expect(completed.body).toMatchObject({
        type: 'document',
        status: 'ready',
        contentType,
        width: null,
        height: null,
        durationMs: null,
        sizeBytes: 12000,
      });
    },
  );

  it.each([
    ['missing visual stream', { videoCodec: '' }],
    ['oversized dimensions', { width: 1921 }],
    ['overlong duration', { durationSeconds: 300.001 }],
    ['oversized bytes', { byteSize: 50 * 1024 * 1024 + 1 }],
    ['wrong format', { format: 'm4a' }],
    ['wrong owner context', { context: {} }],
  ] satisfies Array<[string, Partial<StoredVideoResource>]>)(
    'rejects invalid video completion: %s',
    async (_label, overrides) => {
      const created = await createUpload(
        validUploadInput({
          purpose: 'message_attachment',
          contentType: 'video/mp4',
        }),
      );
      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      )!;
      storage.videoResources.set(pending.cloudinaryPublicId, {
        ...createStoredAudio(pending, { format: 'mp4' }),
        width: 640,
        height: 480,
        videoCodec: 'h264',
        ...overrides,
      });
      await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(409);
      expect(
        mediaRepository.findByClientUpload(userId, CLIENT_UPLOAD_ID)?.status,
      ).toBe('FAILED');
    },
  );

  it.each(['invalid bytes', 'wrong size', 'wrong format', 'wrong context'])(
    'never readies a document with %s',
    async (reason) => {
      const created = await createUpload(
        validUploadInput({
          purpose: 'message_attachment',
          contentType: 'application/pdf',
        }),
      );
      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      )!;
      storage.documentContentValid = reason !== 'invalid bytes';
      storage.documentResources.set(pending.cloudinaryPublicId, {
        ...createStoredImage(pending),
        resourceType: 'raw',
        format: reason === 'wrong format' ? 'exe' : 'pdf',
        byteSize: pending.byteSize + (reason === 'wrong size' ? 1 : 0),
        context:
          reason === 'wrong context'
            ? {}
            : {
                media_id: pending.id,
                upload_fingerprint: pending.uploadFingerprint,
              },
        secureUrl: `https://res.cloudinary.com/classroom/raw/upload/${pending.cloudinaryPublicId}`,
      });
      await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(409);
      expect(
        mediaRepository.findByClientUpload(userId, CLIENT_UPLOAD_ID)?.status,
      ).toBe('FAILED');
    },
  );

  it('rejects oversized and unsupported new uploads at the API boundary', async () => {
    for (const overrides of [
      { contentType: 'video/mp4', sizeBytes: 50 * 1024 * 1024 + 1 },
      { contentType: 'application/pdf', sizeBytes: 25 * 1024 * 1024 + 1 },
      { contentType: 'application/zip' },
      { contentType: 'application/msword' },
      { contentType: 'video/mp4', purpose: 'group_avatar' },
      { contentType: 'application/pdf', purpose: 'profile_avatar' },
    ]) {
      await authorized(request(app.getHttpServer()).post('/v1/media/uploads'))
        .send(validUploadInput({ purpose: 'message_attachment', ...overrides }))
        .expect(400);
    }
  });

  it('protects every media and profile-avatar action with bearer authentication', async () => {
    await request(app.getHttpServer())
      .post('/v1/media/uploads')
      .send(validUploadInput())
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .post('/v1/media/uploads/22222222-2222-4222-8222-222222222222/complete')
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .put('/v1/me/avatar')
      .send({ mediaId: '22222222-2222-4222-8222-222222222222' })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .delete('/v1/me/avatar')
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('creates and safely replays a signed direct-upload authorization', async () => {
    const firstResponse = await authorized(
      request(app.getHttpServer()).post('/v1/media/uploads'),
    )
      .send(validUploadInput())
      .expect(HttpStatus.CREATED)
      .expect('Cache-Control', 'no-store')
      .expect('Pragma', 'no-cache');
    const first = firstResponse.body as CreateUploadBody;

    expect(first).toMatchObject({
      media: {
        id: expect.any(String) as string,
        purpose: 'profile_avatar',
        status: 'pending',
        type: 'image',
        contentType: 'image/jpeg',
        sizeBytes: 245000,
        originalFilename: 'profile-photo.jpg',
        width: null,
        height: null,
        durationMs: null,
        secureUrl: null,
        createdAt: NOW.toISOString(),
        expiresAt: '2026-09-06T10:10:00.000Z',
        completedAt: null,
      },
      upload: {
        url: 'https://api.cloudinary.com/v1_1/classroom/image/upload',
        method: 'POST',
        expiresAt: '2026-09-06T10:10:00.000Z',
        fields: {
          api_key: 'safe-public-key',
          timestamp: '1788688800',
          signature: 'short-lived-signature',
          type: 'upload',
          overwrite: 'false',
          allowed_formats: 'jpg,jpeg,png,webp',
          upload_preset: 'chateo_profile_avatars',
          transformation: 'c_limit,h_2048,w_2048/q_auto',
        },
      },
    });
    expect(first.upload.fields.public_id).toMatch(
      /^chateo\/profile-avatars\/[0-9a-f-]{36}$/,
    );
    expect(first.upload.fields.context).toContain(`media_id=${first.media.id}`);
    expect(JSON.stringify(first)).not.toContain(API_SECRET_SENTINEL);

    const replay = await createUpload();
    expect(replay.media.id).toBe(first.media.id);
    expect(replay.upload.fields.public_id).toBe(first.upload.fields.public_id);
    expect(
      mediaRepository.findByClientUpload(userId, CLIENT_UPLOAD_ID)?.id,
    ).toBe(first.media.id);

    const conflict = await authorized(
      request(app.getHttpServer()).post('/v1/media/uploads'),
    )
      .send(validUploadInput({ sizeBytes: 245001 }))
      .expect(HttpStatus.CONFLICT);
    expect(conflict.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_IDEMPOTENCY_CONFLICT',
      path: '/v1/media/uploads',
    });
  });

  it.each([
    ['message_attachment', 'MESSAGE_ATTACHMENT', 'message-images'],
    ['group_avatar', 'GROUP_AVATAR', 'group-avatars'],
  ] as const)(
    'creates and completes a verified %s image upload',
    async (purpose, storedPurpose, folder) => {
      const created = await createUpload(
        validUploadInput({
          purpose,
          contentType: 'image/webp',
          sizeBytes: 198_765,
          originalFilename: 'chat-photo.webp',
        }),
      );
      expect(created.media).toMatchObject({
        purpose,
        status: 'pending',
        type: 'image',
        contentType: 'image/webp',
        sizeBytes: 198_765,
        originalFilename: 'chat-photo.webp',
      });
      expect(created.upload.fields.public_id).toMatch(
        new RegExp(`^chateo/${folder}/[0-9a-f-]{36}$`),
      );

      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      ) as MediaAssetRecord;
      expect(pending.purpose).toBe(storedPurpose);
      const stored = createStoredImage(pending, {
        byteSize: 150_000,
        width: 1280,
        height: 720,
        secureUrl:
          'https://res.cloudinary.com/classroom/image/upload/message-photo.webp',
      });
      storage.seedImage(stored);

      const completed = await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(HttpStatus.OK);
      expect(completed.body).toMatchObject({
        id: created.media.id,
        purpose,
        status: 'ready',
        type: 'image',
        contentType: 'image/webp',
        sizeBytes: 150_000,
        width: 1280,
        height: 720,
        durationMs: null,
        secureUrl: stored.secureUrl,
        completedAt: NOW.toISOString(),
      });

      const avatarAttempt = await authorized(
        request(app.getHttpServer()).put('/v1/me/avatar'),
      )
        .send({ mediaId: created.media.id })
        .expect(HttpStatus.NOT_FOUND);
      expect(avatarAttempt.body as ApiErrorBody).toMatchObject({
        code: 'MEDIA_UPLOAD_NOT_FOUND',
      });
    },
  );

  it('creates and completes a signed Cloudinary audio upload with verified duration metadata', async () => {
    const created = await createUpload(
      validUploadInput({
        purpose: 'message_attachment',
        contentType: 'audio/m4a',
        sizeBytes: 2_345_678,
        originalFilename: 'voice-note.m4a',
      }),
    );
    expect(created.media).toMatchObject({
      purpose: 'message_attachment',
      status: 'pending',
      type: 'audio',
      contentType: 'audio/m4a',
      sizeBytes: 2_345_678,
      originalFilename: 'voice-note.m4a',
      width: null,
      height: null,
      durationMs: null,
      secureUrl: null,
    });
    expect(created.upload).toMatchObject({
      url: 'https://api.cloudinary.com/v1_1/classroom/video/upload',
      method: 'POST',
      fields: {
        allowed_formats: 'aac,m4a,mp3,ogg,wav',
        upload_preset: 'chateo_chat_audio',
        type: 'upload',
        overwrite: 'false',
      },
    });
    expect(created.upload.fields).not.toHaveProperty('transformation');
    expect(created.upload.fields.public_id).toMatch(
      /^chateo\/message-audio\/[0-9a-f-]{36}$/,
    );
    expect(storage.signAudioCalls).toHaveLength(1);
    expect(storage.signCalls).toHaveLength(0);

    const pending = mediaRepository.findByClientUpload(
      userId,
      CLIENT_UPLOAD_ID,
    ) as MediaAssetRecord;
    expect(pending.resourceType).toBe('video');
    const stored = createStoredAudio(pending, {
      byteSize: 1_900_000,
      durationSeconds: 12.345,
    });
    storage.seedAudio(stored);

    const completed = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.OK);
    expect(completed.body).toMatchObject({
      id: created.media.id,
      purpose: 'message_attachment',
      status: 'ready',
      type: 'audio',
      contentType: 'audio/m4a',
      sizeBytes: 1_900_000,
      width: null,
      height: null,
      durationMs: 12_345,
      secureUrl: stored.secureUrl,
      completedAt: NOW.toISOString(),
    });
    expect(storage.findAudioCalls).toEqual([pending.cloudinaryPublicId]);
    expect(storage.findCalls).toHaveLength(0);

    const avatarAttempt = await authorized(
      request(app.getHttpServer()).put('/v1/me/avatar'),
    )
      .send({ mediaId: created.media.id })
      .expect(HttpStatus.NOT_FOUND);
    expect(avatarAttempt.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_NOT_FOUND',
    });
  });

  it.each([
    ['audio/aac', 'aac'],
    ['audio/mp4', 'm4a'],
    ['audio/x-m4a', 'm4a'],
    ['audio/mpeg', 'mp3'],
    ['audio/ogg', 'ogg'],
    ['audio/wav', 'wav'],
    ['audio/x-wav', 'wav'],
  ])(
    'accepts and verifies the %s audio format pair',
    async (contentType, format) => {
      const created = await createUpload(
        validUploadInput({
          purpose: 'message_attachment',
          contentType,
          sizeBytes: 80_000,
          originalFilename: `recording.${format}`,
        }),
      );
      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      ) as MediaAssetRecord;
      storage.seedAudio(createStoredAudio(pending, { format }));

      const completed = await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(HttpStatus.OK);
      expect(completed.body).toMatchObject({
        type: 'audio',
        contentType,
        durationMs: 42_125,
      });
    },
  );

  it('reports an audio-specific 503 and safely retries after audio signing is configured', async () => {
    const input = validUploadInput({
      purpose: 'message_attachment',
      contentType: 'audio/m4a',
      sizeBytes: 80_000,
    });
    storage.signError = new MediaStorageError(
      'audio-not-configured',
      'missing audio preset',
    );

    const disabled = await authorized(
      request(app.getHttpServer()).post('/v1/media/uploads'),
    )
      .send(input)
      .expect(HttpStatus.SERVICE_UNAVAILABLE);
    expect(disabled.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_AUDIO_UPLOADS_DISABLED',
      path: '/v1/media/uploads',
    });

    storage.signError = null;
    const retry = await authorized(
      request(app.getHttpServer()).post('/v1/media/uploads'),
    )
      .send(input)
      .expect(HttpStatus.CREATED);
    expect((retry.body as CreateUploadBody).upload.url).toMatch(
      /\/video\/upload$/,
    );
    expect(storage.signAudioCalls).toHaveLength(2);
  });

  it.each([
    ['a zero duration', { durationSeconds: 0 }],
    ['a duration above 15 minutes', { durationSeconds: 900.001 }],
    ['a mismatched stored format', { format: 'mp3' }],
    ['a stored object above 20 MiB', { byteSize: 20 * 1024 * 1024 + 1 }],
  ])(
    'rejects audio completion with %s',
    async (_label, overrides: Partial<StoredAudioResource>) => {
      const created = await createUpload(
        validUploadInput({
          purpose: 'message_attachment',
          contentType: 'audio/m4a',
          sizeBytes: 80_000,
        }),
      );
      const pending = mediaRepository.findByClientUpload(
        userId,
        CLIENT_UPLOAD_ID,
      ) as MediaAssetRecord;
      storage.seedAudio(createStoredAudio(pending, overrides));

      const response = await authorized(
        request(app.getHttpServer()).post(
          `/v1/media/uploads/${created.media.id}/complete`,
        ),
      ).expect(HttpStatus.CONFLICT);
      expect(response.body as ApiErrorBody).toMatchObject({
        code: 'MEDIA_UPLOAD_VERIFICATION_FAILED',
      });
      expect(
        mediaRepository.findByClientUpload(userId, CLIENT_UPLOAD_ID)?.status,
      ).toBe('FAILED');
    },
  );

  it.each([
    ['unknown property', validUploadInput({ debug: true })],
    ['invalid idempotency UUID', validUploadInput({ clientUploadId: 'bad' })],
    ['unsupported purpose', validUploadInput({ purpose: 'message_video' })],
    ['unsupported media type', validUploadInput({ contentType: 'image/gif' })],
    [
      'audio used as a profile avatar',
      validUploadInput({ contentType: 'audio/m4a' }),
    ],
    [
      'audio used as a group avatar',
      validUploadInput({ purpose: 'group_avatar', contentType: 'audio/m4a' }),
    ],
    ['zero-byte file', validUploadInput({ sizeBytes: 0 })],
    ['oversized file', validUploadInput({ sizeBytes: 5 * 1024 * 1024 + 1 })],
    [
      'oversized audio recording',
      validUploadInput({
        purpose: 'message_attachment',
        contentType: 'audio/mpeg',
        sizeBytes: 20 * 1024 * 1024 + 1,
      }),
    ],
    ['invalid SHA-256', validUploadInput({ contentSha256: 'not-a-hash' })],
    [
      'PostgreSQL-null filename',
      validUploadInput({ originalFilename: 'unsafe\u0000name.jpg' }),
    ],
  ])('rejects %s before creating an upload', async (_label, payload) => {
    const response = await authorized(
      request(app.getHttpServer()).post('/v1/media/uploads'),
    )
      .send(payload)
      .expect(HttpStatus.BAD_REQUEST);
    expect(response.body as ApiErrorBody).toMatchObject({
      code: 'VALIDATION_ERROR',
      path: '/v1/media/uploads',
    });
  });

  it('distinguishes not-yet-uploaded media from a verification failure', async () => {
    const created = await createUpload();
    const pending = mediaRepository.findByClientUpload(
      userId,
      CLIENT_UPLOAD_ID,
    );
    expect(pending).not.toBeNull();

    const notReady = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.CONFLICT);
    expect(notReady.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_NOT_READY',
    });

    storage.seedImage(
      createStoredImage(pending as MediaAssetRecord, {
        context: { media_id: 'different-media' },
      }),
    );
    const mismatch = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.CONFLICT);
    expect(mismatch.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_VERIFICATION_FAILED',
    });
    expect(
      mediaRepository.findByClientUpload(userId, CLIENT_UPLOAD_ID)?.status,
    ).toBe('FAILED');
    expect(storage.deleteCalls).toHaveLength(0);

    const terminalReplay = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.CONFLICT);
    expect(terminalReplay.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_NOT_COMPLETABLE',
    });
  });

  it('completes matching media and replays completion without storage access', async () => {
    const created = await createUpload();
    const pending = mediaRepository.findByClientUpload(
      userId,
      CLIENT_UPLOAD_ID,
    ) as MediaAssetRecord;
    storage.seedImage(createStoredImage(pending, { byteSize: 120000 }));

    const first = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    )
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    expect(first.body).toMatchObject({
      id: created.media.id,
      status: 'ready',
      width: 640,
      height: 480,
      sizeBytes: 120000,
      secureUrl: createStoredImage(pending).secureUrl,
      completedAt: NOW.toISOString(),
    });
    expect(storage.findCalls).toHaveLength(1);

    const replay = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.OK);
    expect(replay.body).toEqual(first.body);
    expect(storage.findCalls).toHaveLength(1);
  });

  it('preserves pending state when media storage is disabled or unavailable', async () => {
    const created = await createUpload();
    storage.findError = new MediaStorageError('not-configured', 'disabled');

    const disabled = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.SERVICE_UNAVAILABLE);
    expect(disabled.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOADS_DISABLED',
    });

    storage.findError = new MediaStorageError('unavailable', 'offline');
    const unavailable = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.BAD_GATEWAY);
    expect(unavailable.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_STORAGE_UNAVAILABLE',
    });
    expect(
      mediaRepository.findByClientUpload(userId, CLIENT_UPLOAD_ID)?.status,
    ).toBe('PENDING');
    expect(storage.deleteCalls).toHaveLength(0);
  });

  it('expires pending media and keeps owner lookups private', async () => {
    const created = await createUpload();
    mediaClock.advanceSeconds(600);

    const expired = await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.GONE);
    expect(expired.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_EXPIRED',
    });

    const foreign = mediaRepository.findByClientUpload(
      userId,
      CLIENT_UPLOAD_ID,
    ) as MediaAssetRecord;
    mediaRepository.seedAsset({
      ...foreign,
      id: '88888888-8888-4888-8888-888888888888',
      ownerId: FOREIGN_USER_ID,
      clientUploadId: '77777777-7777-4777-8777-777777777777',
      status: 'READY',
      secureUrl:
        'https://res.cloudinary.com/classroom/image/upload/foreign.jpg',
      completedAt: NOW,
    });

    const foreignCompletion = await authorized(
      request(app.getHttpServer()).post(
        '/v1/media/uploads/88888888-8888-4888-8888-888888888888/complete',
      ),
    ).expect(HttpStatus.NOT_FOUND);
    expect(foreignCompletion.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_NOT_FOUND',
    });

    const foreignSelection = await authorized(
      request(app.getHttpServer()).put('/v1/me/avatar'),
    )
      .send({ mediaId: '88888888-8888-4888-8888-888888888888' })
      .expect(HttpStatus.NOT_FOUND);
    expect(foreignSelection.body as ApiErrorBody).toMatchObject({
      code: 'MEDIA_UPLOAD_NOT_FOUND',
    });
  });

  it('requires a ready owned asset, then sets and clears the avatar idempotently', async () => {
    const created = await createUpload();

    const pendingResponse = await authorized(
      request(app.getHttpServer()).put('/v1/me/avatar'),
    )
      .send({ mediaId: created.media.id })
      .expect(HttpStatus.CONFLICT);
    expect(pendingResponse.body as ApiErrorBody).toMatchObject({
      code: 'PROFILE_AVATAR_NOT_READY',
    });

    const pending = mediaRepository.findByClientUpload(
      userId,
      CLIENT_UPLOAD_ID,
    ) as MediaAssetRecord;
    const stored = createStoredImage(pending, { byteSize: 120000 });
    storage.seedImage(stored);
    await authorized(
      request(app.getHttpServer()).post(
        `/v1/media/uploads/${created.media.id}/complete`,
      ),
    ).expect(HttpStatus.OK);

    const selected = await authorized(
      request(app.getHttpServer()).put('/v1/me/avatar'),
    )
      .send({ mediaId: created.media.id })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    expect(selected.body).toMatchObject({
      id: userId,
      avatarUrl: stored.secureUrl,
      profileComplete: false,
    });
    expect(mediaRepository.inspectUser(userId)?.avatarUrl).toBe(
      stored.secureUrl,
    );

    await authorized(request(app.getHttpServer()).delete('/v1/me/avatar'))
      .expect(HttpStatus.NO_CONTENT)
      .expect('Cache-Control', 'no-store');
    await authorized(
      request(app.getHttpServer()).delete('/v1/me/avatar'),
    ).expect(HttpStatus.NO_CONTENT);
    expect(mediaRepository.inspectUser(userId)?.avatarUrl).toBeNull();
  });

  it.each([
    ['completion', 'post', '/v1/media/uploads/not-a-uuid/complete', undefined],
    ['avatar selection', 'put', '/v1/me/avatar', { mediaId: 'not-a-uuid' }],
  ] as const)(
    'validates media IDs for %s',
    async (_label, method, path, payload) => {
      const pendingRequest =
        method === 'post'
          ? request(app.getHttpServer()).post(path)
          : request(app.getHttpServer()).put(path);
      const response = await authorized(pendingRequest)
        .send(payload)
        .expect(HttpStatus.BAD_REQUEST);
      expect(response.body as ApiErrorBody).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    },
  );
});

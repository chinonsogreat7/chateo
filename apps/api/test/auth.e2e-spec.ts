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
import { UsersController } from '../src/users/users.controller';
import { UsersService } from '../src/users/users.service';
import {
  InMemoryAuthRepository,
  InspectableOtpDeliveryProvider,
  ManualClock,
} from './support/auth-test-doubles';

interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: {
    attemptsRemaining?: number;
    errors?: string[];
    retryAfterSeconds?: number;
  };
  path: string;
}

interface OtpChallengeBody {
  challengeId: string;
  phoneNumberMasked: string;
  expiresInSeconds: number;
  resendInSeconds: number;
  codeLength: number;
}

interface UserBody {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileComplete: boolean;
  createdAt: string;
}

interface AuthBody {
  accessToken: string;
  accessTokenExpiresInSeconds: number;
  refreshToken: string;
  refreshTokenExpiresInSeconds: number;
  user: UserBody;
}

const PHONE_NUMBER = '+14155552671';
const TEST_OTP = '2468';
const INITIAL_TIME = new Date('2026-08-09T09:00:00.000Z');

describe('Authentication API (e2e, in memory)', () => {
  let app: INestApplication;
  let repository: InMemoryAuthRepository;
  let clock: ManualClock;
  let otpDelivery: InspectableOtpDeliveryProvider;

  beforeEach(async () => {
    repository = new InMemoryAuthRepository();
    clock = new ManualClock(INITIAL_TIME);
    otpDelivery = new InspectableOtpDeliveryProvider();

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
      controllers: [AuthController, UsersController],
      providers: [
        AuthService,
        UsersService,
        { provide: AuthRepository, useValue: repository },
        { provide: Clock, useValue: clock },
        { provide: OtpDeliveryProvider, useValue: otpDelivery },
        PhoneNumberService,
        OtpCodeService,
        RefreshTokenService,
        AccessTokenService,
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
  });

  afterEach(async () => {
    await app.close();
  });

  async function requestOtp(): Promise<OtpChallengeBody> {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/otp/request')
      .send({ phoneNumber: PHONE_NUMBER })
      .expect(HttpStatus.ACCEPTED);
    return response.body as OtpChallengeBody;
  }

  async function authenticate(): Promise<AuthBody> {
    const challenge = await requestOtp();
    const response = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .set('User-Agent', 'ChatMe-e2e/1.0')
      .send({
        challengeId: challenge.challengeId,
        code: TEST_OTP,
        device: { name: 'Test iPhone', platform: 'ios' },
      })
      .expect(HttpStatus.OK);
    return response.body as AuthBody;
  }

  it('requests the configured 4-digit test OTP without exposing it in the API response', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/auth/otp/request')
      .send({ phoneNumber: `  ${PHONE_NUMBER}  ` })
      .expect(HttpStatus.ACCEPTED)
      .expect('Cache-Control', 'no-store')
      .expect('Pragma', 'no-cache');
    const challenge = response.body as OtpChallengeBody;

    expect(challenge).toEqual({
      challengeId: expect.any(String) as string,
      phoneNumberMasked: '+141******71',
      expiresInSeconds: 300,
      resendInSeconds: 24,
      codeLength: 4,
    });
    expect(challenge).not.toHaveProperty('code');
    expect(otpDelivery.deliveries).toEqual([
      {
        phoneNumber: PHONE_NUMBER,
        code: TEST_OTP,
        expiresAt: new Date('2026-08-09T09:05:00.000Z'),
      },
    ]);
    expect(repository.challengeRecords).toHaveLength(1);
    expect(repository.challengeRecords[0]?.codeDigest).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(repository.challengeRecords[0]?.codeDigest).not.toContain(TEST_OTP);
  });

  it('returns stable validation and domain errors for invalid request input', async () => {
    const invalidPhoneResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/request')
      .send({ phoneNumber: '08012345678' })
      .expect(HttpStatus.BAD_REQUEST);
    expect(invalidPhoneResponse.body as ApiErrorBody).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'AUTH_INVALID_PHONE_NUMBER',
      path: '/v1/auth/otp/request',
    });

    const invalidTypeResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/request')
      .send({ phoneNumber: 1234 })
      .expect(HttpStatus.BAD_REQUEST);
    expect(invalidTypeResponse.body as ApiErrorBody).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_ERROR',
      details: {
        errors: expect.arrayContaining([
          'phoneNumber must be a string',
        ]) as string[],
      },
    });

    const unknownFieldResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/request')
      .send({ phoneNumber: PHONE_NUMBER, debug: true })
      .expect(HttpStatus.BAD_REQUEST);
    expect(unknownFieldResponse.body as ApiErrorBody).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_ERROR',
      details: {
        errors: expect.arrayContaining([
          'property debug should not exist',
        ]) as string[],
      },
    });

    const invalidVerificationResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .send({ challengeId: 'not-a-uuid', code: '123' })
      .expect(HttpStatus.BAD_REQUEST);
    expect(invalidVerificationResponse.body as ApiErrorBody).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_ERROR',
      details: {
        errors: expect.arrayContaining([
          'challengeId must be a UUID',
          'code must contain 4 to 8 digits',
        ]) as string[],
      },
    });
    expect(otpDelivery.deliveries).toHaveLength(0);
  });

  it('rejects a code with the wrong configured length without spending an attempt', async () => {
    const challenge = await requestOtp();

    const response = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .send({ challengeId: challenge.challengeId, code: '123456' })
      .expect(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(response.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_OTP_CODE_FORMAT',
    });
    expect(
      repository.challengeRecords.find(
        (record) => record.id === challenge.challengeId,
      )?.attemptsRemaining,
    ).toBe(5);

    await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .send({ challengeId: challenge.challengeId, code: TEST_OTP })
      .expect(HttpStatus.OK);
  });

  it('enforces resend cooldown and carries the failed-attempt budget across challenges', async () => {
    const firstChallenge = await requestOtp();

    const cooldownResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/resend')
      .send({ challengeId: firstChallenge.challengeId })
      .expect(HttpStatus.TOO_MANY_REQUESTS);
    expect(cooldownResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_OTP_COOLDOWN',
      details: { retryAfterSeconds: 24 },
    });
    expect(otpDelivery.deliveries).toHaveLength(1);

    for (const attemptsRemaining of [4, 3]) {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/otp/verify')
        .send({ challengeId: firstChallenge.challengeId, code: '0000' })
        .expect(HttpStatus.UNAUTHORIZED);
      expect(response.body as ApiErrorBody).toMatchObject({
        code: 'AUTH_INVALID_OTP',
        details: { attemptsRemaining },
      });
    }

    clock.advanceSeconds(24);
    const resendResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/resend')
      .send({ challengeId: firstChallenge.challengeId })
      .expect(HttpStatus.ACCEPTED);
    const secondChallenge = resendResponse.body as OtpChallengeBody;

    expect(secondChallenge.challengeId).not.toBe(firstChallenge.challengeId);
    expect(otpDelivery.deliveries).toHaveLength(2);
    expect(
      repository.challengeRecords.find(
        (challenge) => challenge.id === firstChallenge.challengeId,
      )?.consumedAt,
    ).toEqual(clock.now());
    expect(
      repository.challengeRecords.find(
        (challenge) => challenge.id === secondChallenge.challengeId,
      )?.attemptsRemaining,
    ).toBe(3);

    for (const attemptsRemaining of [2, 1, 0]) {
      const response = await request(app.getHttpServer())
        .post('/v1/auth/otp/verify')
        .send({ challengeId: secondChallenge.challengeId, code: '0000' })
        .expect(HttpStatus.UNAUTHORIZED);
      expect(response.body as ApiErrorBody).toMatchObject({
        code: 'AUTH_INVALID_OTP',
        details: { attemptsRemaining },
      });
    }

    const lockedVerificationResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .send({ challengeId: secondChallenge.challengeId, code: TEST_OTP })
      .expect(HttpStatus.TOO_MANY_REQUESTS);
    expect(lockedVerificationResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_OTP_ATTEMPTS_EXCEEDED',
    });

    clock.advanceSeconds(24);
    const lockedResendResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/resend')
      .send({ challengeId: secondChallenge.challengeId })
      .expect(HttpStatus.TOO_MANY_REQUESTS);
    expect(lockedResendResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_OTP_ATTEMPTS_EXCEEDED',
      details: { retryAfterSeconds: 876 },
    });
    expect(otpDelivery.deliveries).toHaveLength(2);
  });

  it('verifies the OTP, persists device metadata, and completes the profile', async () => {
    const challenge = await requestOtp();
    const verifyResponse = await request(app.getHttpServer())
      .post('/v1/auth/otp/verify')
      .set('User-Agent', 'ChatMe-iOS/1.0')
      .send({
        challengeId: challenge.challengeId,
        code: TEST_OTP,
        device: { name: "  Great's iPhone  ", platform: 'ios' },
      })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    const auth = verifyResponse.body as AuthBody;

    expect(auth).toMatchObject({
      accessToken: expect.any(String) as string,
      accessTokenExpiresInSeconds: 900,
      refreshToken: expect.any(String) as string,
      refreshTokenExpiresInSeconds: 2_592_000,
      user: {
        phoneNumber: PHONE_NUMBER,
        displayName: null,
        avatarUrl: null,
        profileComplete: false,
      },
    });
    const sessionId = auth.refreshToken.split('.')[0];
    expect(sessionId).toBeDefined();
    expect(repository.inspectSession(sessionId ?? '')).toMatchObject({
      deviceName: "Great's iPhone",
      platform: 'IOS',
      userAgent: 'ChatMe-iOS/1.0',
      revokedAt: null,
    });

    const getResponse = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);
    expect(getResponse.body as UserBody).toMatchObject({
      id: auth.user.id,
      phoneNumber: PHONE_NUMBER,
      profileComplete: false,
    });

    const patchResponse = await request(app.getHttpServer())
      .patch('/v1/me')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .send({
        displayName: '  Great Ichoku  ',
        avatarUrl: 'https://cdn.example.com/avatars/great.png',
      })
      .expect(HttpStatus.OK);
    expect(patchResponse.body as UserBody).toMatchObject({
      id: auth.user.id,
      displayName: 'Great Ichoku',
      avatarUrl: 'https://cdn.example.com/avatars/great.png',
      profileComplete: true,
    });

    const persistedProfileResponse = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.OK);
    expect(persistedProfileResponse.body).toEqual(patchResponse.body);
  });

  it('rotates refresh tokens and revokes the whole family when an old token is replayed', async () => {
    const initialAuth = await authenticate();
    const initialSessionId = initialAuth.refreshToken.split('.')[0] ?? '';

    const refreshResponse = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: initialAuth.refreshToken })
      .expect(HttpStatus.OK);
    const rotatedAuth = refreshResponse.body as AuthBody;
    const rotatedSessionId = rotatedAuth.refreshToken.split('.')[0] ?? '';

    expect(rotatedAuth.refreshToken).not.toBe(initialAuth.refreshToken);
    expect(rotatedAuth.accessToken).not.toBe(initialAuth.accessToken);
    expect(repository.inspectSession(initialSessionId)).toMatchObject({
      revokedReason: 'ROTATED',
    });
    expect(repository.inspectSession(rotatedSessionId)).toMatchObject({
      familyId: repository.inspectSession(initialSessionId)?.familyId,
      revokedAt: null,
    });

    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${initialAuth.accessToken}`)
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${rotatedAuth.accessToken}`)
      .expect(HttpStatus.OK);

    const replayResponse = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: initialAuth.refreshToken })
      .expect(HttpStatus.UNAUTHORIZED);
    expect(replayResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_REUSED',
    });
    expect(repository.inspectSession(rotatedSessionId)).toMatchObject({
      revokedReason: 'REUSE_DETECTED',
    });

    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${rotatedAuth.accessToken}`)
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('revokes the whole session family on logout and makes repeated logout safe', async () => {
    const auth = await authenticate();
    const sessionId = auth.refreshToken.split('.')[0] ?? '';
    const session = repository.inspectSession(sessionId);
    expect(session).not.toBeNull();
    const siblingSessionId = '00000000-0000-4000-8000-000000000099';
    repository.seedSession({
      ...(session as NonNullable<typeof session>),
      id: siblingSessionId,
      tokenDigest: 'sibling-session-digest',
    });

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .send({ refreshToken: auth.refreshToken })
      .expect(HttpStatus.NO_CONTENT);
    expect(repository.inspectSession(sessionId)).toMatchObject({
      revokedReason: 'LOGOUT',
    });
    expect(repository.inspectSession(siblingSessionId)).toMatchObject({
      revokedReason: 'LOGOUT',
    });

    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${auth.accessToken}`)
      .expect(HttpStatus.UNAUTHORIZED);
    const refreshResponse = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: auth.refreshToken })
      .expect(HttpStatus.UNAUTHORIZED);
    expect(refreshResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_REFRESH_TOKEN_INVALID',
    });

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .send({ refreshToken: auth.refreshToken })
      .expect(HttpStatus.NO_CONTENT);
  });

  it('uses a rotated token to log out its active successor session', async () => {
    const initialAuth = await authenticate();
    const refreshResponse = await request(app.getHttpServer())
      .post('/v1/auth/refresh')
      .send({ refreshToken: initialAuth.refreshToken })
      .expect(HttpStatus.OK);
    const rotatedAuth = refreshResponse.body as AuthBody;
    const rotatedSessionId = rotatedAuth.refreshToken.split('.')[0] ?? '';

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .send({ refreshToken: initialAuth.refreshToken })
      .expect(HttpStatus.NO_CONTENT);
    expect(repository.inspectSession(rotatedSessionId)).toMatchObject({
      revokedReason: 'LOGOUT',
    });
    await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', `Bearer ${rotatedAuth.accessToken}`)
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('logs out an expired session without changing its last-used timestamp', async () => {
    const auth = await authenticate();
    const sessionId = auth.refreshToken.split('.')[0] ?? '';
    const lastUsedAt = repository.inspectSession(sessionId)?.lastUsedAt;
    clock.advanceSeconds(2_592_001);

    await request(app.getHttpServer())
      .post('/v1/auth/logout')
      .send({ refreshToken: auth.refreshToken })
      .expect(HttpStatus.NO_CONTENT);
    expect(repository.inspectSession(sessionId)).toMatchObject({
      lastUsedAt,
      revokedReason: 'LOGOUT',
    });
  });

  it('protects /me when the bearer token is absent or invalid', async () => {
    const missingTokenResponse = await request(app.getHttpServer())
      .get('/v1/me')
      .expect(HttpStatus.UNAUTHORIZED);
    expect(missingTokenResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_ACCESS_TOKEN_INVALID',
      path: '/v1/me',
    });

    const invalidTokenResponse = await request(app.getHttpServer())
      .get('/v1/me')
      .set('Authorization', 'Bearer definitely-not-a-jwt')
      .expect(HttpStatus.UNAUTHORIZED);
    expect(invalidTokenResponse.body as ApiErrorBody).toMatchObject({
      code: 'AUTH_ACCESS_TOKEN_INVALID',
      path: '/v1/me',
    });
  });
});

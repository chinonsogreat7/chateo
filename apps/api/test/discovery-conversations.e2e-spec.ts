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
import { AuthRepository } from '../src/auth/auth.repository';
import type { AuthSessionRecord, AuthUserRecord } from '../src/auth/auth.types';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AccessTokenService } from '../src/auth/providers/access-token.service';
import { Clock } from '../src/auth/providers/clock';
import { PhoneNumberService } from '../src/auth/providers/phone-number.service';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { NoStoreInterceptor } from '../src/common/no-store.interceptor';
import { ConversationSettingsController } from '../src/conversation-settings/conversation-settings.controller';
import { ConversationSettingsRepository } from '../src/conversation-settings/conversation-settings.repository';
import { ConversationSettingsService } from '../src/conversation-settings/conversation-settings.service';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationEventsPublisher } from '../src/conversations/conversation-events.publisher';
import { ConversationsRepository } from '../src/conversations/conversations.repository';
import { ConversationsService } from '../src/conversations/conversations.service';
import { validateEnvironment } from '../src/config/environment';
import { DiscoveryController } from '../src/discovery/discovery.controller';
import { DiscoveryRepository } from '../src/discovery/discovery.repository';
import { DiscoveryService } from '../src/discovery/discovery.service';
import {
  InMemoryAuthRepository,
  ManualClock,
} from './support/auth-test-doubles';
import { InMemoryDiscoveryConversationsRepository } from './support/discovery-conversations-test-double';

interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

interface ConversationBody {
  id: string;
  type: 'direct';
  otherParticipant: {
    id: string;
    displayName: string | null;
    avatarUrl: string | null;
  };
  latestMessage: null;
  unreadCount: number;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

const INITIAL_TIME = new Date('2026-08-12T12:30:00.000Z');
const ALICE_ID = '00000000-0000-4000-8000-000000000101';
const BOB_ID = '00000000-0000-4000-8000-000000000102';
const CAROL_ID = '00000000-0000-4000-8000-000000000103';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000199';
const ALICE_PHONE = '+12025550101';
const BOB_PHONE = '+12025550102';
const CAROL_PHONE = '+12025550103';
const UNKNOWN_PHONE = '+12025550199';

function user(
  id: string,
  phoneNumber: string,
  displayName: string,
  createdAt: Date,
): AuthUserRecord {
  return {
    id,
    phoneNumber,
    phoneVerifiedAt: new Date(createdAt),
    displayName,
    avatarUrl: null,
    profileCompletedAt: new Date(createdAt),
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

function session(
  id: string,
  userId: string,
  digestCharacter: string,
): AuthSessionRecord {
  return {
    id,
    familyId: id,
    userId,
    tokenDigest: digestCharacter.repeat(64),
    deviceName: 'E2E device',
    platform: 'UNKNOWN',
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date('2026-09-12T12:30:00.000Z'),
    lastUsedAt: new Date(INITIAL_TIME),
    revokedAt: null,
    revokedReason: null,
  };
}

describe('Discovery and direct conversations API (e2e, in memory)', () => {
  let app: INestApplication;
  let repository: InMemoryDiscoveryConversationsRepository;
  let clock: ManualClock;
  let events: jest.Mocked<ConversationEventsPublisher>;
  let aliceToken: string;
  let bobToken: string;
  let carolToken: string;

  const alice = user(
    ALICE_ID,
    ALICE_PHONE,
    'Alice Johnson',
    new Date('2026-08-12T09:00:00.000Z'),
  );
  const bob = user(
    BOB_ID,
    BOB_PHONE,
    'Bob Okafor',
    new Date('2026-08-12T10:00:00.000Z'),
  );
  const carol = user(
    CAROL_ID,
    CAROL_PHONE,
    'Carol Mensah',
    new Date('2026-08-12T11:00:00.000Z'),
  );

  beforeEach(async () => {
    const authRepository = new InMemoryAuthRepository();
    repository = new InMemoryDiscoveryConversationsRepository();
    clock = new ManualClock(INITIAL_TIME);
    events = {
      publishCreated: jest.fn().mockResolvedValue(undefined),
      publishSettingsUpdated: jest.fn().mockResolvedValue(undefined),
      publishGroupChanged: jest.fn().mockResolvedValue(undefined),
    };

    for (const record of [alice, bob, carol]) {
      authRepository.seedUser(record);
      repository.seedUser({
        id: record.id,
        phoneNumber: record.phoneNumber,
        displayName: record.displayName,
        avatarUrl: record.avatarUrl,
        profileCompletedAt: record.profileCompletedAt,
        createdAt: record.createdAt,
      });
    }

    const aliceSession = session(
      '00000000-0000-4000-8000-000000000201',
      ALICE_ID,
      'a',
    );
    const bobSession = session(
      '00000000-0000-4000-8000-000000000202',
      BOB_ID,
      'b',
    );
    const carolSession = session(
      '00000000-0000-4000-8000-000000000203',
      CAROL_ID,
      'c',
    );
    for (const record of [aliceSession, bobSession, carolSession]) {
      authRepository.seedSession(record);
    }

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
      controllers: [
        DiscoveryController,
        ConversationSettingsController,
        ConversationsController,
      ],
      providers: [
        DiscoveryService,
        ConversationSettingsService,
        ConversationsService,
        AccessTokenService,
        PhoneNumberService,
        NoStoreInterceptor,
        { provide: AuthRepository, useValue: authRepository },
        { provide: DiscoveryRepository, useValue: repository },
        { provide: ConversationsRepository, useValue: repository },
        { provide: ConversationSettingsRepository, useValue: repository },
        {
          provide: ConversationEventsPublisher,
          useValue: events,
        },
        { provide: Clock, useValue: clock },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    const accessTokens = moduleFixture.get(AccessTokenService);
    aliceToken = (await accessTokens.issue(alice, aliceSession.id)).token;
    bobToken = (await accessTokens.issue(bob, bobSession.id)).token;
    carolToken = (await accessTokens.issue(carol, carolSession.id)).token;

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

  it('requires a valid access token for discovery and conversations', async () => {
    await request(app.getHttpServer())
      .post('/v1/contacts/match')
      .send({ phoneNumbers: [BOB_PHONE] })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get('/v1/conversations')
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .put(`/v1/conversations/${UNKNOWN_ID}/archive`)
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .delete(`/v1/conversations/${UNKNOWN_ID}/archive`)
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('matches only known submitted contacts without exposing directory phone numbers', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/contacts/match')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        phoneNumbers: [
          ALICE_PHONE,
          ` ${BOB_PHONE} `,
          UNKNOWN_PHONE,
          CAROL_PHONE,
          BOB_PHONE,
        ],
      })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store')
      .expect('Pragma', 'no-cache');

    expect(response.body).toEqual({
      matches: [
        {
          matchedPhoneNumber: BOB_PHONE,
          user: { id: BOB_ID, displayName: 'Bob Okafor', avatarUrl: null },
        },
        {
          matchedPhoneNumber: CAROL_PHONE,
          user: { id: CAROL_ID, displayName: 'Carol Mensah', avatarUrl: null },
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('phoneNumber');
    expect(JSON.stringify(response.body)).not.toContain(UNKNOWN_PHONE);
  });

  it('searches completed profiles by display name but never by phone number', async () => {
    const nameResponse = await request(app.getHttpServer())
      .get('/v1/users/search')
      .query({ q: '  bOB  ' })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(nameResponse.body).toEqual({
      items: [{ id: BOB_ID, displayName: 'Bob Okafor', avatarUrl: null }],
      nextCursor: null,
    });
    expect(JSON.stringify(nameResponse.body)).not.toContain('phoneNumber');

    const phoneResponse = await request(app.getHttpServer())
      .get('/v1/users/search')
      .query({ q: BOB_PHONE.slice(1) })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(phoneResponse.body).toEqual({ items: [], nextCursor: null });
  });

  it('creates one direct conversation that both members can list and open', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: BOB_ID })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    const created = createResponse.body as ConversationBody;

    expect(created).toMatchObject({
      id: expect.any(String) as string,
      type: 'direct',
      otherParticipant: {
        id: BOB_ID,
        displayName: 'Bob Okafor',
        avatarUrl: null,
      },
      latestMessage: null,
      unreadCount: 0,
      lastActivityAt: INITIAL_TIME.toISOString(),
    });
    expect(created.otherParticipant).not.toHaveProperty('phoneNumber');

    const repeated = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: BOB_ID })
      .expect(HttpStatus.OK);
    const reversed = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ participantId: ALICE_ID })
      .expect(HttpStatus.OK);
    expect(repeated.body.id).toBe(created.id);
    expect(reversed.body.id).toBe(created.id);
    expect(repository.conversationCount).toBe(1);

    const aliceList = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(aliceList.body).toMatchObject({
      items: [{ id: created.id, otherParticipant: { id: BOB_ID } }],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });

    const bobList = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(bobList.body).toMatchObject({
      items: [{ id: created.id, otherParticipant: { id: ALICE_ID } }],
    });

    const carolList = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${carolToken}`)
      .expect(HttpStatus.OK);
    expect(carolList.body).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });

    await request(app.getHttpServer())
      .get(`/v1/conversations/${created.id}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    await request(app.getHttpServer())
      .get(`/v1/conversations/${created.id}`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);

    const forbidden = await request(app.getHttpServer())
      .get(`/v1/conversations/${created.id}`)
      .set('Authorization', `Bearer ${carolToken}`)
      .expect(HttpStatus.NOT_FOUND);
    expect(forbidden.body as ApiErrorBody).toMatchObject({
      statusCode: HttpStatus.NOT_FOUND,
      code: 'CONVERSATION_NOT_FOUND',
      message: 'The conversation was not found.',
    });
  });

  it('archives and unarchives a conversation idempotently for only the caller', async () => {
    const created = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: BOB_ID })
      .expect(HttpStatus.OK);
    const conversationId = (created.body as ConversationBody).id;
    clock.advanceSeconds(60);
    const archivedAt = clock.now().toISOString();
    events.publishSettingsUpdated.mockClear();

    const archived = await request(app.getHttpServer())
      .put(`/v1/conversations/${conversationId}/archive`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    expect(archived.body).toEqual({
      conversationId,
      archived: true,
      muted: false,
      pinned: false,
      favorited: false,
      archivedAt,
      mutedAt: null,
      mutedUntil: null,
      pinnedAt: null,
      favoritedAt: null,
      clearedAt: null,
      clearedThroughMessageId: null,
    });

    clock.advanceSeconds(60);
    const repeatedArchive = await request(app.getHttpServer())
      .put(`/v1/conversations/${conversationId}/archive`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(repeatedArchive.body).toEqual(archived.body);

    const aliceActive = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(aliceActive.body.items).toEqual([]);
    const aliceArchived = await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(aliceArchived.body).toMatchObject({
      items: [
        {
          id: conversationId,
          settings: {
            archived: true,
            muted: false,
            pinned: false,
            favorited: false,
            archivedAt,
            mutedAt: null,
            mutedUntil: null,
            pinnedAt: null,
            favoritedAt: null,
            clearedAt: null,
            clearedThroughMessageId: null,
          },
        },
      ],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });

    const bobActive = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(bobActive.body.items).toEqual([
      expect.objectContaining({
        id: conversationId,
        settings: expect.objectContaining({ archived: false }),
      }),
    ]);
    const bobArchived = await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(bobArchived.body.items).toEqual([]);

    const unarchived = await request(app.getHttpServer())
      .delete(`/v1/conversations/${conversationId}/archive`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(unarchived.body).toEqual({
      ...archived.body,
      archived: false,
      archivedAt: null,
    });
    const repeatedUnarchive = await request(app.getHttpServer())
      .delete(`/v1/conversations/${conversationId}/archive`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(repeatedUnarchive.body).toEqual(unarchived.body);
    expect(events.publishSettingsUpdated).toHaveBeenCalledTimes(2);

    const inaccessible = await request(app.getHttpServer())
      .put(`/v1/conversations/${conversationId}/archive`)
      .set('Authorization', `Bearer ${carolToken}`)
      .expect(HttpStatus.NOT_FOUND);
    expect(inaccessible.body as ApiErrorBody).toMatchObject({
      code: 'CONVERSATION_NOT_FOUND',
    });
  });

  it('paginates archived conversations and rejects cursors from the active list', async () => {
    const withBob = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: BOB_ID })
      .expect(HttpStatus.OK);
    clock.advanceSeconds(1);
    const withCarol = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: CAROL_ID })
      .expect(HttpStatus.OK);
    const expectedIds = [
      withCarol.body.id as string,
      withBob.body.id as string,
    ];

    const activePage = await request(app.getHttpServer())
      .get('/v1/conversations')
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    const activeCursor = activePage.body.pageInfo.nextCursor as string;
    expect(activeCursor).toEqual(expect.any(String));

    for (const conversationId of expectedIds) {
      await request(app.getHttpServer())
        .put(`/v1/conversations/${conversationId}/archive`)
        .set('Authorization', `Bearer ${aliceToken}`)
        .expect(HttpStatus.OK);
    }

    const activeAfterArchive = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(activeAfterArchive.body.items).toEqual([]);

    const firstPage = await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .query({ limit: 1 })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(firstPage.body).toMatchObject({
      items: [
        {
          id: expectedIds[0],
          settings: { archived: true, archivedAt: expect.any(String) },
        },
      ],
      pageInfo: { hasNextPage: true, nextCursor: expect.any(String) },
    });

    const secondPage = await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .query({ limit: 1, cursor: firstPage.body.pageInfo.nextCursor })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(secondPage.body).toMatchObject({
      items: [{ id: expectedIds[1], settings: { archived: true } }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });

    const legacySecondPage = await request(app.getHttpServer())
      .get('/v1/conversations')
      .query({
        archived: true,
        limit: 1,
        cursor: firstPage.body.pageInfo.nextCursor,
      })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(legacySecondPage.body).toMatchObject({
      items: [{ id: expectedIds[1], settings: { archived: true } }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });

    const legacyFirstPage = await request(app.getHttpServer())
      .get('/v1/conversations')
      .query({ archived: true, limit: 1 })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    const dedicatedSecondPage = await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .query({ limit: 1, cursor: legacyFirstPage.body.pageInfo.nextCursor })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(dedicatedSecondPage.body).toMatchObject({
      items: [{ id: expectedIds[1], settings: { archived: true } }],
      pageInfo: { hasNextPage: false, nextCursor: null },
    });

    const legacyArchivedList = await request(app.getHttpServer())
      .get('/v1/conversations')
      .query({ archived: true })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(
      legacyArchivedList.body.items.map((item: ConversationBody) => item.id),
    ).toEqual(expectedIds);

    const mismatchedCursor = await request(app.getHttpServer())
      .get('/v1/conversations/archived')
      .query({ cursor: activeCursor })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.BAD_REQUEST);
    expect(mismatchedCursor.body as ApiErrorBody).toMatchObject({
      code: 'CONVERSATION_CURSOR_INVALID',
    });

    const reverseMismatch = await request(app.getHttpServer())
      .get('/v1/conversations')
      .query({ cursor: firstPage.body.pageInfo.nextCursor })
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.BAD_REQUEST);
    expect(reverseMismatch.body as ApiErrorBody).toMatchObject({
      code: 'CONVERSATION_CURSOR_INVALID',
    });
  });

  it('returns stable validation and domain errors for unsafe requests', async () => {
    const invalidContactResponse = await request(app.getHttpServer())
      .post('/v1/contacts/match')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ phoneNumbers: [BOB_PHONE, '08012345678'] })
      .expect(HttpStatus.BAD_REQUEST);
    expect(invalidContactResponse.body as ApiErrorBody).toMatchObject({
      code: 'CONTACTS_INVALID_PHONE_NUMBER',
      details: { invalidIndices: [1] },
    });

    const typedContactResponse = await request(app.getHttpServer())
      .post('/v1/contacts/match')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ phoneNumbers: [BOB_PHONE, 1234, 'x'.repeat(33)] })
      .expect(HttpStatus.BAD_REQUEST);
    expect(typedContactResponse.body as ApiErrorBody).toMatchObject({
      code: 'CONTACTS_INVALID_PHONE_NUMBER',
      details: { invalidIndices: [1, 2] },
    });

    const emptyContactsResponse = await request(app.getHttpServer())
      .post('/v1/contacts/match')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ phoneNumbers: [] })
      .expect(HttpStatus.BAD_REQUEST);
    expect(emptyContactsResponse.body as ApiErrorBody).toMatchObject({
      code: 'VALIDATION_ERROR',
    });

    const invalidRequests = [
      () =>
        request(app.getHttpServer())
          .post('/v1/contacts/match')
          .set('Authorization', `Bearer ${aliceToken}`)
          .send({ phoneNumbers: Array.from({ length: 101 }, () => BOB_PHONE) }),
      () =>
        request(app.getHttpServer())
          .get('/v1/users/search')
          .query({ q: 'ab' })
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .get('/v1/users/search')
          .query({ q: 'Ada', limit: 26 })
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .get('/v1/conversations')
          .query({ limit: 51 })
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .get('/v1/conversations/archived')
          .query({ limit: 51 })
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .get('/v1/conversations/archived')
          .query({ archived: false })
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .put('/v1/conversations/not-a-uuid/archive')
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .delete('/v1/conversations/not-a-uuid/archive')
          .set('Authorization', `Bearer ${aliceToken}`),
      () =>
        request(app.getHttpServer())
          .post('/v1/conversations/direct')
          .set('Authorization', `Bearer ${aliceToken}`)
          .send({ participantId: 'not-a-uuid' }),
      () =>
        request(app.getHttpServer())
          .post('/v1/conversations/direct')
          .set('Authorization', `Bearer ${aliceToken}`)
          .send({ participantId: BOB_ID, unexpected: true }),
    ];
    for (const createInvalidRequest of invalidRequests) {
      const response = await createInvalidRequest().expect(
        HttpStatus.BAD_REQUEST,
      );
      expect(response.body as ApiErrorBody).toMatchObject({
        code: 'VALIDATION_ERROR',
      });
    }

    const selfResponse = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: ALICE_ID })
      .expect(HttpStatus.BAD_REQUEST);
    expect(selfResponse.body as ApiErrorBody).toMatchObject({
      code: 'CONVERSATION_SELF_NOT_ALLOWED',
    });

    const missingUserResponse = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantId: UNKNOWN_ID })
      .expect(HttpStatus.NOT_FOUND);
    expect(missingUserResponse.body as ApiErrorBody).toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });
});

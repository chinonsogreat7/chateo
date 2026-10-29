import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { Clock } from '../src/auth/providers/clock';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { MessageCollectionsController } from '../src/messages/message-collections.controller';
import { MessageStarsService } from '../src/messages/message-stars.service';
import { MessagesService } from '../src/messages/messages.service';
import { MessagesRepository } from '../src/messages/messages.repository';
import { MessageEventsPublisher } from '../src/messages/message-events.publisher';
import { ParticipantProfilesController } from '../src/users/participant-profiles.controller';
import { ParticipantProfilesService } from '../src/users/participant-profiles.service';

const USER = '00000000-0000-4000-8000-000000002801';
const CHAT = '00000000-0000-4000-8000-000000002802';
const MESSAGE = '00000000-0000-4000-8000-000000002803';
const OTHER = '00000000-0000-4000-8000-000000002804';
const NOW = new Date('2026-10-28T12:00:00.000Z');

describe('chat detail HTTP contracts', () => {
  let app: INestApplication;
  let token: string;
  let otherToken: string;
  const listForMember = jest.fn();
  const isSessionActive = jest.fn();
  const profileGet = jest.fn();
  const starGet = jest.fn();
  const starSet = jest.fn();

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'chat-details-tests-only-secret-32-characters',
        }),
      ],
      controllers: [
        MessageCollectionsController,
        ParticipantProfilesController,
      ],
      providers: [
        MessagesService,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: Clock, useValue: { now: () => NOW } },
        { provide: AuthRepository, useValue: { isSessionActive } },
        { provide: MessagesRepository, useValue: { listForMember } },
        { provide: MessageEventsPublisher, useValue: {} },
        { provide: ParticipantProfilesService, useValue: { get: profileGet } },
        {
          provide: MessageStarsService,
          useValue: { get: starGet, set: starSet },
        },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const jwt = module.get(JwtService);
    token = jwt.sign({ sub: USER, sid: MESSAGE, profileComplete: true });
    otherToken = jwt.sign({ sub: OTHER, sid: MESSAGE, profileComplete: true });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isSessionActive.mockResolvedValue(true);
    listForMember.mockResolvedValue({
      status: 'found',
      messages: [MESSAGE, OTHER].map((id) => ({
        id,
        conversationId: CHAT,
        clientMessageId: id,
        senderId: USER,
        kind: 'TEXT',
        text: 'https://example.org',
        links: ['https://example.org'],
        attachments: [],
        createdAt: NOW,
        participantIds: [USER, OTHER],
      })),
    });
    profileGet.mockResolvedValue({
      id: OTHER,
      displayName: 'Learner',
      bio: 'Building chat',
      avatarUrl: null,
      phoneNumber: null,
      lastSeenAt: null,
    });
    starGet.mockResolvedValue({
      conversationId: CHAT,
      messageId: MESSAGE,
      starred: false,
      starredAt: null,
    });
    starSet.mockResolvedValue({
      conversationId: CHAT,
      messageId: MESSAGE,
      starred: true,
      starredAt: NOW.toISOString(),
    });
  });

  it('guards all new reads and writes and rejects revoked sessions', async () => {
    for (const route of [
      `${CHAT}/shared-media`,
      `${CHAT}/shared-links`,
      `${CHAT}/starred-messages`,
      `${CHAT}/participants/${OTHER}`,
      `${CHAT}/messages/${MESSAGE}/star`,
    ]) {
      await request(app.getHttpServer())
        .get(`/v1/conversations/${route}`)
        .expect(401);
    }
    for (const method of ['put', 'delete'] as const)
      await request(app.getHttpServer())
        [method](`/v1/conversations/${CHAT}/messages/${MESSAGE}/star`)
        .expect(401);
    isSessionActive.mockResolvedValue(false);
    await request(app.getHttpServer())
      .get(`/v1/conversations/${CHAT}/shared-links`)
      .auth(token, { type: 'bearer' })
      .expect(401);
    expect(listForMember).not.toHaveBeenCalled();
  });

  it('validates IDs, page limits and media kinds before reading data', async () => {
    for (const route of [
      'invalid/shared-media',
      `${CHAT}/shared-media?limit=0`,
      `${CHAT}/shared-media?limit=101`,
      `${CHAT}/shared-media?kind=text`,
      `${CHAT}/shared-media?kind=IMAGE`,
      `${CHAT}/shared-links?cursor=invalid!`,
      `${CHAT}/participants/not-an-id`,
    ]) {
      await request(app.getHttpServer())
        .get(`/v1/conversations/${route}`)
        .auth(token, { type: 'bearer' })
        .expect(400);
    }
    expect(listForMember).not.toHaveBeenCalled();
    expect(profileGet).not.toHaveBeenCalled();
  });

  it('returns no-store paginated responses and rejects cursor reuse across collections, kinds, users or chats', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/conversations/${CHAT}/shared-media?kind=image&limit=1`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.headers['cache-control']).toContain('no-store');
    const body = response.body as {
      items: unknown[];
      pageInfo: { nextCursor: string; hasNextPage: boolean };
    };
    expect(body.items).toHaveLength(1);
    expect(body.pageInfo.hasNextPage).toBe(true);
    expect(listForMember).toHaveBeenLastCalledWith(
      CHAT,
      USER,
      null,
      2,
      undefined,
      { collection: 'media', kind: 'image' },
    );
    const cursor = encodeURIComponent(body.pageInfo.nextCursor);
    await request(app.getHttpServer())
      .get(
        `/v1/conversations/${CHAT}/shared-media?kind=image&limit=1&cursor=${cursor}`,
      )
      .auth(token, { type: 'bearer' })
      .expect(200);
    for (const [path, bearer] of [
      [`${CHAT}/shared-links`, token],
      [`${CHAT}/starred-messages`, token],
      [`${CHAT}/shared-media?kind=video`, token],
      [`${OTHER}/shared-media?kind=image`, token],
      [`${CHAT}/shared-media?kind=image`, otherToken],
    ] as const) {
      await request(app.getHttpServer())
        .get(
          `/v1/conversations/${path}${path.includes('?') ? '&' : '?'}cursor=${cursor}`,
        )
        .auth(bearer, { type: 'bearer' })
        .expect(400);
    }
  });

  it('uses the authenticated caller for profile and private-star routes', async () => {
    const profile = await request(app.getHttpServer())
      .get(`/v1/conversations/${CHAT}/participants/${OTHER}`)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(profile.body).toMatchObject({ phoneNumber: null, lastSeenAt: null });
    expect(profileGet).toHaveBeenCalledWith(USER, CHAT, OTHER);
    const route = `/v1/conversations/${CHAT}/messages/${MESSAGE}/star`;
    await request(app.getHttpServer())
      .put(route)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(starSet).toHaveBeenLastCalledWith(USER, CHAT, MESSAGE, true);
    await request(app.getHttpServer())
      .delete(route)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(starSet).toHaveBeenLastCalledWith(USER, CHAT, MESSAGE, false);
    await request(app.getHttpServer())
      .get(route)
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(starGet).toHaveBeenCalledWith(USER, CHAT, MESSAGE);
  });

  it('documents all new operations and pagination in Swagger', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().addBearerAuth().build(),
    );
    for (const path of [
      'shared-media',
      'shared-links',
      'starred-messages',
      'participants/{userId}',
    ]) {
      expect(
        doc.paths[`/v1/conversations/{conversationId}/${path}`]?.get?.security,
      ).toEqual([{ bearer: [] }]);
    }
    const star =
      doc.paths['/v1/conversations/{conversationId}/messages/{messageId}/star'];
    for (const operation of [star?.get, star?.put, star?.delete])
      expect(operation?.responses['200']).toBeDefined();
    expect(doc.components?.schemas?.MessageResponseDto).toMatchObject({
      properties: { links: { type: 'array', items: { type: 'string' } } },
    });
  });
});

import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BlocksController } from '../src/blocks/blocks.controller';
import { BlocksRepository } from '../src/blocks/blocks.repository';
import { BlocksService } from '../src/blocks/blocks.service';
import { Clock } from '../src/auth/providers/clock';
import { ApiException } from '../src/common/errors/api.exception';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { NoStoreInterceptor } from '../src/common/no-store.interceptor';
import type { AuthenticatedRequest } from '../src/common/types/authenticated-request';
import { ConversationSettingsController } from '../src/conversation-settings/conversation-settings.controller';
import { ConversationSettingsRepository } from '../src/conversation-settings/conversation-settings.repository';
import { ConversationSettingsService } from '../src/conversation-settings/conversation-settings.service';
import { ConversationEventsPublisher } from '../src/conversations/conversation-events.publisher';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationsRepository } from '../src/conversations/conversations.repository';
import { ConversationsService } from '../src/conversations/conversations.service';

const NOW = new Date('2026-09-03T12:00:00.000Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const SECOND_TARGET_ID = '55555555-5555-4555-8555-555555555555';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

@Injectable()
class TestBearerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.headers.authorization !== 'Bearer classroom-token') {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_ACCESS_TOKEN_INVALID',
        'A valid access token is required.',
      );
    }
    request.user = {
      sub: USER_ID,
      sid: '66666666-6666-4666-8666-666666666666',
      profileComplete: true,
    };
    return true;
  }
}

describe('Chat management API (e2e, in memory)', () => {
  let app: INestApplication;
  let blocks: jest.Mocked<BlocksRepository>;
  let settings: jest.Mocked<ConversationSettingsRepository>;
  let conversations: jest.Mocked<ConversationsRepository>;

  beforeEach(async () => {
    blocks = {
      listForUser: jest.fn().mockResolvedValue([
        {
          user: {
            id: TARGET_ID,
            displayName: 'Ada Okafor',
            avatarUrl: null,
          },
          blockedAt: NOW,
        },
      ]),
      block: jest.fn().mockResolvedValue({
        status: 'blocked',
        block: {
          user: {
            id: TARGET_ID,
            displayName: 'Ada Okafor',
            avatarUrl: null,
          },
          blockedAt: NOW,
        },
      }),
      unblock: jest.fn().mockResolvedValue(undefined),
      hasBlockBetween: jest.fn().mockResolvedValue(false),
    };
    settings = {
      updateForMember: jest.fn().mockResolvedValue({
        status: 'updated',
        changed: true,
        settings: {
          conversationId: CONVERSATION_ID,
          archivedAt: NOW,
          mutedAt: null,
          pinnedAt: NOW,
        },
      }),
    };
    conversations = {
      createOrGetDirect: jest.fn(),
      createGroup: jest.fn().mockResolvedValue({
        status: 'created',
        conversation: {
          id: CONVERSATION_ID,
          type: 'GROUP',
          name: 'Study Group',
          avatarUrl: null,
          participants: [
            {
              id: USER_ID,
              displayName: 'Teacher',
              avatarUrl: null,
              role: 'OWNER',
            },
            {
              id: TARGET_ID,
              displayName: 'Ada Okafor',
              avatarUrl: null,
              role: 'MEMBER',
            },
            {
              id: SECOND_TARGET_ID,
              displayName: 'Tunde Bello',
              avatarUrl: null,
              role: 'MEMBER',
            },
          ],
          role: 'OWNER',
          latestMessage: null,
          unreadCount: 0,
          lastActivityAt: NOW,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
      listForUser: jest.fn(),
      findForUser: jest.fn(),
    };
    const events: jest.Mocked<ConversationEventsPublisher> = {
      publishCreated: jest.fn().mockResolvedValue(undefined),
      publishSettingsUpdated: jest.fn().mockResolvedValue(undefined),
    };
    const clock: Clock = { now: jest.fn().mockReturnValue(NOW) };

    const moduleFixture = await Test.createTestingModule({
      controllers: [
        BlocksController,
        ConversationSettingsController,
        ConversationsController,
      ],
      providers: [
        BlocksService,
        ConversationSettingsService,
        ConversationsService,
        NoStoreInterceptor,
        { provide: BlocksRepository, useValue: blocks },
        { provide: ConversationSettingsRepository, useValue: settings },
        { provide: ConversationsRepository, useValue: conversations },
        { provide: ConversationEventsPublisher, useValue: events },
        { provide: Clock, useValue: clock },
        { provide: APP_GUARD, useClass: TestBearerGuard },
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

  it('protects every chat-management route with bearer authentication', async () => {
    await request(app.getHttpServer()).get('/v1/me/blocks').expect(401);
    await request(app.getHttpServer())
      .patch(`/v1/conversations/${CONVERSATION_ID}/settings`)
      .send({ pinned: true })
      .expect(401);
    await request(app.getHttpServer())
      .post('/v1/conversations/group')
      .send({ name: 'Study Group', participantIds: [TARGET_ID] })
      .expect(401);
  });

  it('lists, creates, and removes user blocks without exposing phone numbers', async () => {
    const created = await request(app.getHttpServer())
      .put(`/v1/me/blocks/${TARGET_ID}`)
      .set('Authorization', 'Bearer classroom-token')
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    expect(created.body).toEqual({
      user: { id: TARGET_ID, displayName: 'Ada Okafor', avatarUrl: null },
      blockedAt: NOW.toISOString(),
    });

    const list = await request(app.getHttpServer())
      .get('/v1/me/blocks')
      .set('Authorization', 'Bearer classroom-token')
      .expect(HttpStatus.OK);
    expect(list.body.items).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('phoneNumber');

    await request(app.getHttpServer())
      .delete(`/v1/me/blocks/${TARGET_ID}`)
      .set('Authorization', 'Bearer classroom-token')
      .expect(HttpStatus.NO_CONTENT);
  });

  it('updates archive, mute, and pin state and rejects an empty update', async () => {
    const response = await request(app.getHttpServer())
      .patch(`/v1/conversations/${CONVERSATION_ID}/settings`)
      .set('Authorization', 'Bearer classroom-token')
      .send({ archived: true, muted: false, pinned: true })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    expect(response.body).toEqual({
      conversationId: CONVERSATION_ID,
      archived: true,
      muted: false,
      pinned: true,
      archivedAt: NOW.toISOString(),
      mutedAt: null,
      pinnedAt: NOW.toISOString(),
    });

    const invalid = await request(app.getHttpServer())
      .patch(`/v1/conversations/${CONVERSATION_ID}/settings`)
      .set('Authorization', 'Bearer classroom-token')
      .send({})
      .expect(HttpStatus.BAD_REQUEST);
    expect(invalid.body).toMatchObject({
      code: 'CONVERSATION_SETTINGS_UPDATE_EMPTY',
    });
  });

  it('creates a validated group with owner and member roles', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/conversations/group')
      .set('Authorization', 'Bearer classroom-token')
      .send({
        name: '  Study Group  ',
        participantIds: [TARGET_ID, SECOND_TARGET_ID],
      })
      .expect(HttpStatus.CREATED)
      .expect('Cache-Control', 'no-store');

    expect(response.body).toMatchObject({
      id: CONVERSATION_ID,
      type: 'group',
      name: 'Study Group',
      participants: [
        { id: USER_ID, role: 'owner' },
        { id: TARGET_ID, role: 'member' },
        { id: SECOND_TARGET_ID, role: 'member' },
      ],
      role: 'owner',
      settings: { archived: false, muted: false, pinned: false },
    });
    expect(conversations.createGroup).toHaveBeenCalledWith({
      creatorId: USER_ID,
      name: 'Study Group',
      avatarUrl: null,
      participantIds: [TARGET_ID, SECOND_TARGET_ID],
      now: NOW,
    });
  });
});

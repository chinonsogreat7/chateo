import {
  HttpStatus,
  type INestApplication,
  ValidationPipe,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { io, type Socket } from 'socket.io-client';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import type { AuthSessionRecord, AuthUserRecord } from '../src/auth/auth.types';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { AccessTokenService } from '../src/auth/providers/access-token.service';
import { Clock } from '../src/auth/providers/clock';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { NoStoreInterceptor } from '../src/common/no-store.interceptor';
import { validateEnvironment } from '../src/config/environment';
import { ConversationSettingsController } from '../src/conversation-settings/conversation-settings.controller';
import {
  ConversationSettingsRepository,
  type UpdateConversationSettingsInput,
} from '../src/conversation-settings/conversation-settings.repository';
import { ConversationSettingsService } from '../src/conversation-settings/conversation-settings.service';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationEventsPublisher } from '../src/conversations/conversation-events.publisher';
import { ConversationsRepository } from '../src/conversations/conversations.repository';
import { ConversationsService } from '../src/conversations/conversations.service';
import { MessageEventsPublisher } from '../src/messages/message-events.publisher';
import { MessagesController } from '../src/messages/messages.controller';
import { MessagesRepository } from '../src/messages/messages.repository';
import { MessagesService } from '../src/messages/messages.service';
import { ReceiptEventsPublisher } from '../src/receipts/receipt-events.publisher';
import { ReceiptsController } from '../src/receipts/receipts.controller';
import { ReceiptsRepository } from '../src/receipts/receipts.repository';
import { ReceiptsService } from '../src/receipts/receipts.service';
import { ChatStateService } from '../src/realtime/chat-state.service';
import { ChatGateway } from '../src/realtime/chat.gateway';
import { RealtimeAuthenticator } from '../src/realtime/realtime-authenticator';
import { RealtimeConversationsRepository } from '../src/realtime/realtime-conversations.repository';
import { RealtimeIoAdapter } from '../src/realtime/realtime-io.adapter';
import { RealtimeMessageEventsPublisher } from '../src/realtime/realtime-message-events.publisher';
import { RealtimeConversationEventsPublisher } from '../src/realtime/realtime-conversation-events.publisher';
import { RealtimeReceiptEventsPublisher } from '../src/realtime/realtime-receipt-events.publisher';
import {
  CONVERSATION_CREATED_EVENT,
  CONVERSATION_SETTINGS_UPDATED_EVENT,
  MESSAGE_CREATED_EVENT,
  PRESENCE_CHANGED_EVENT,
  PRESENCE_SUBSCRIBE_COMMAND,
  REALTIME_AUTH_ERROR_CODE,
  REALTIME_AUTH_ERROR_MESSAGE,
  REALTIME_CONVERSATION_ERROR_CODE,
  REALTIME_CONVERSATION_ERROR_MESSAGE,
  REALTIME_PAYLOAD_ERROR_CODE,
  REALTIME_PAYLOAD_ERROR_MESSAGE,
  RECEIPT_DELIVERED_EVENT,
  RECEIPT_READ_EVENT,
  TYPING_START_COMMAND,
  TYPING_STARTED_EVENT,
  TYPING_STOP_COMMAND,
  TYPING_STOPPED_EVENT,
  type ConversationCreatedEventPayload,
  type ConversationSettingsUpdatedEventPayload,
  type MessageCreatedEventPayload,
  type PresenceChangedEventPayload,
  type PresenceSubscriptionData,
  type RealtimeAck,
  type ReceiptUpdatedEventPayload,
  type TypingStartedData,
  type TypingStartedEventPayload,
  type TypingStoppedData,
  type TypingStoppedEventPayload,
} from '../src/realtime/realtime.types';
import {
  InMemoryAuthRepository,
  ManualClock,
} from './support/auth-test-doubles';
import { InMemoryMessagingRepository } from './support/messaging-test-double';

interface ApiErrorBody {
  statusCode: number;
  code: string;
  message: string;
}

type MessageBody = MessageCreatedEventPayload;

interface MessageHistoryBody {
  items: MessageBody[];
  pageInfo: {
    nextCursor: string | null;
    hasNextPage: boolean;
  };
}

interface ReceiptUpdateBody {
  conversationId: string;
  status: 'delivered' | 'read';
  throughMessageId: string;
  at: string;
  changed: boolean;
  version: number;
  unreadCount: number;
  delivered: { messageId: string; at: string };
  read: { messageId: string; at: string } | null;
}

interface ReceiptFrontiersBody {
  conversationId: string;
  items: Array<{
    userId: string;
    version: number;
    delivered: { messageId: string; at: string } | null;
    read: { messageId: string; at: string } | null;
  }>;
}

interface SocketErrorWithData extends Error {
  data?: unknown;
}

const ALICE_ID = '00000000-0000-4000-8000-000000000101';
const BOB_ID = '00000000-0000-4000-8000-000000000102';
const CAROL_ID = '00000000-0000-4000-8000-000000000103';
const ALICE_PHONE = '+12025550101';
const BOB_PHONE = '+12025550102';
const CAROL_PHONE = '+12025550103';
const CONVERSATION_ID = '00000000-0000-4000-8000-000000000301';
const SECOND_CONVERSATION_ID = '00000000-0000-4000-8000-000000000302';
const MISSING_CONVERSATION_ID = '00000000-0000-4000-8000-000000000399';
const ALICE_SESSION_ID = '00000000-0000-4000-8000-000000000201';
const ALICE_SECOND_SESSION_ID = '00000000-0000-4000-8000-000000000204';
const BOB_SESSION_ID = '00000000-0000-4000-8000-000000000202';
const CAROL_SESSION_ID = '00000000-0000-4000-8000-000000000203';
const CLIENT_MESSAGE_ID = '10000000-0000-4000-8000-000000000001';
const SECOND_CLIENT_MESSAGE_ID = '10000000-0000-4000-8000-000000000002';
const THIRD_CLIENT_MESSAGE_ID = '10000000-0000-4000-8000-000000000003';

jest.setTimeout(15_000);

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
  now: Date,
): AuthSessionRecord {
  return {
    id,
    familyId: id,
    userId,
    tokenDigest: digestCharacter.repeat(64),
    deviceName: 'Messaging E2E device',
    platform: 'UNKNOWN',
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    lastUsedAt: new Date(now),
    revokedAt: null,
    revokedReason: null,
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  failureMessage: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(failureMessage);
    await delay(10);
  }
}

function waitForConnection(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Socket connection timed out.')),
      2_000,
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once('connect_error', (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.connect();
  });
}

function waitForConnectionError(socket: Socket): Promise<SocketErrorWithData> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Expected a socket authentication error.')),
      2_000,
    );
    socket.once('connect', () => {
      clearTimeout(timer);
      reject(new Error('The unauthenticated socket unexpectedly connected.'));
    });
    socket.once('connect_error', (error: SocketErrorWithData) => {
      clearTimeout(timer);
      resolve(error);
    });
    socket.connect();
  });
}

function emitWithAck<T>(
  socket: Socket,
  event: string,
  payload: unknown,
): Promise<RealtimeAck<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Socket acknowledgement for ${event} timed out.`)),
      2_000,
    );
    socket.emit(event, payload, (response: RealtimeAck<T>) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function shortenServerTimer(
  duration: number,
  replacement: number,
): jest.SpyInstance {
  const nativeSetTimeout = global.setTimeout;
  const implementation = (
    ...args: Parameters<typeof setTimeout>
  ): ReturnType<typeof setTimeout> => {
    const [callback, milliseconds, ...callbackArguments] = args;
    return nativeSetTimeout(
      callback,
      milliseconds === duration ? replacement : milliseconds,
      ...callbackArguments,
    );
  };
  return jest.spyOn(global, 'setTimeout').mockImplementation(implementation);
}

describe('Messaging REST and realtime API (e2e, in memory)', () => {
  let app: INestApplication;
  let serverUrl: string;
  let clock: ManualClock;
  let authRepository: InMemoryAuthRepository;
  let messagingRepository: InMemoryMessagingRepository;
  let chatGateway: ChatGateway;
  let aliceToken: string;
  let aliceSecondToken: string;
  let bobToken: string;
  let carolToken: string;
  let sockets: Socket[];

  beforeEach(async () => {
    const initialTime = new Date();
    clock = new ManualClock(initialTime);
    authRepository = new InMemoryAuthRepository();
    messagingRepository = new InMemoryMessagingRepository();
    sockets = [];

    const alice = user(ALICE_ID, ALICE_PHONE, 'Alice Johnson', initialTime);
    const bob = user(BOB_ID, BOB_PHONE, 'Bob Okafor', initialTime);
    const carol = user(CAROL_ID, CAROL_PHONE, 'Carol Mensah', initialTime);
    for (const record of [alice, bob, carol]) {
      authRepository.seedUser(record);
      messagingRepository.seedUser({
        id: record.id,
        displayName: record.displayName,
        avatarUrl: record.avatarUrl,
      });
    }

    const sessions = [
      session(ALICE_SESSION_ID, ALICE_ID, 'a', initialTime),
      session(ALICE_SECOND_SESSION_ID, ALICE_ID, 'd', initialTime),
      session(BOB_SESSION_ID, BOB_ID, 'b', initialTime),
      session(CAROL_SESSION_ID, CAROL_ID, 'c', initialTime),
    ];
    for (const record of sessions) authRepository.seedSession(record);

    const conversationCreatedAt = new Date(
      initialTime.getTime() - 60 * 60 * 1000,
    );
    messagingRepository.seedDirectConversation(
      CONVERSATION_ID,
      ALICE_ID,
      BOB_ID,
      conversationCreatedAt,
    );
    messagingRepository.seedDirectConversation(
      SECOND_CONVERSATION_ID,
      ALICE_ID,
      CAROL_ID,
      conversationCreatedAt,
    );

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
        MessagesController,
        ConversationsController,
        ConversationSettingsController,
        ReceiptsController,
      ],
      providers: [
        MessagesService,
        ConversationsService,
        ConversationSettingsService,
        ReceiptsService,
        AccessTokenService,
        NoStoreInterceptor,
        ChatGateway,
        ChatStateService,
        RealtimeAuthenticator,
        RealtimeMessageEventsPublisher,
        RealtimeConversationEventsPublisher,
        RealtimeReceiptEventsPublisher,
        {
          provide: MessageEventsPublisher,
          useExisting: RealtimeMessageEventsPublisher,
        },
        {
          provide: ConversationEventsPublisher,
          useExisting: RealtimeConversationEventsPublisher,
        },
        {
          provide: ReceiptEventsPublisher,
          useExisting: RealtimeReceiptEventsPublisher,
        },
        { provide: AuthRepository, useValue: authRepository },
        { provide: MessagesRepository, useValue: messagingRepository },
        { provide: ConversationsRepository, useValue: messagingRepository },
        {
          provide: ConversationSettingsRepository,
          useValue: {
            updateForMember: jest
              .fn()
              .mockImplementation((input: UpdateConversationSettingsInput) =>
                Promise.resolve({
                  status: 'updated',
                  changed: true,
                  settings: {
                    conversationId: input.conversationId,
                    archivedAt: input.archived ? input.now : null,
                    mutedAt: input.muted ? input.now : null,
                    pinnedAt: input.pinned ? input.now : null,
                  },
                }),
              ),
          },
        },
        { provide: ReceiptsRepository, useValue: messagingRepository },
        {
          provide: RealtimeConversationsRepository,
          useValue: messagingRepository,
        },
        { provide: Clock, useValue: clock },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    const accessTokens = moduleFixture.get(AccessTokenService);
    aliceToken = (await accessTokens.issue(alice, ALICE_SESSION_ID)).token;
    aliceSecondToken = (
      await accessTokens.issue(alice, ALICE_SECOND_SESSION_ID)
    ).token;
    bobToken = (await accessTokens.issue(bob, BOB_SESSION_ID)).token;
    carolToken = (await accessTokens.issue(carol, CAROL_SESSION_ID)).token;
    chatGateway = moduleFixture.get(ChatGateway);

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
    app.useWebSocketAdapter(
      new RealtimeIoAdapter(app, moduleFixture.get(ConfigService)),
    );
    await app.listen(0, '127.0.0.1');
    serverUrl = await app.getUrl();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const socket of sockets) {
      socket.removeAllListeners();
      socket.disconnect();
    }
    await app.close();
  });

  function createSocket(token?: string): Socket {
    const socket = io(`${serverUrl}/chat`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 2_000,
      transports: ['websocket'],
      auth: token === undefined ? {} : { token },
    });
    sockets.push(socket);
    return socket;
  }

  async function connectSocket(token: string): Promise<Socket> {
    const socket = createSocket(token);
    await waitForConnection(socket);
    return socket;
  }

  async function waitForRoutedSocketCount(
    userIds: string[],
    expectedCount: number,
  ): Promise<void> {
    await waitUntil(async () => {
      const routedSockets = await chatGateway.findSocketsForUsers(userIds);
      return routedSockets.length === expectedCount;
    }, `Expected ${expectedCount} routed socket(s).`);
  }

  async function sendMessage(
    token: string,
    conversationId: string,
    clientMessageId: string,
    text: string,
  ): Promise<MessageBody> {
    const response = await request(app.getHttpServer())
      .post(`/v1/conversations/${conversationId}/messages`)
      .set('Authorization', `Bearer ${token}`)
      .send({ clientMessageId, text })
      .expect(HttpStatus.OK);
    return response.body as MessageBody;
  }

  it('requires a valid access token for every messaging REST operation', async () => {
    await request(app.getHttpServer())
      .post(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, text: 'Hello' })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .post(`/v1/conversations/${CONVERSATION_ID}/read`)
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
      .send({ throughMessageId: CLIENT_MESSAGE_ID })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/read`)
      .send({ throughMessageId: CLIENT_MESSAGE_ID })
      .expect(HttpStatus.UNAUTHORIZED);
    await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/receipts`)
      .expect(HttpStatus.UNAUTHORIZED);
  });

  it('publishes conversation.created through the socket layer only for a newly created direct chat', async () => {
    const bobSocket = await connectSocket(bobToken);
    const carolSocket = await connectSocket(carolToken);
    await waitForRoutedSocketCount([BOB_ID, CAROL_ID], 2);

    const bobEvents: ConversationCreatedEventPayload[] = [];
    const carolEvents: ConversationCreatedEventPayload[] = [];
    bobSocket.on(CONVERSATION_CREATED_EVENT, (payload) =>
      bobEvents.push(payload as ConversationCreatedEventPayload),
    );
    carolSocket.on(CONVERSATION_CREATED_EVENT, (payload) =>
      carolEvents.push(payload as ConversationCreatedEventPayload),
    );

    const created = await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ participantId: CAROL_ID })
      .expect(HttpStatus.OK);
    await waitUntil(
      () => bobEvents.length === 1 && carolEvents.length === 1,
      'Expected conversation.created on both participant sockets.',
    );

    const expectedEvent = {
      conversationId: created.body.id as string,
      type: 'direct',
      occurredAt: clock.now().toISOString(),
    };
    expect(bobEvents).toEqual([expectedEvent]);
    expect(carolEvents).toEqual([expectedEvent]);

    await request(app.getHttpServer())
      .post('/v1/conversations/direct')
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ participantId: CAROL_ID })
      .expect(HttpStatus.OK);
    await delay(50);
    expect(bobEvents).toHaveLength(1);
    expect(carolEvents).toHaveLength(1);
  });

  it('publishes conversation settings changes only to the updating user devices', async () => {
    const aliceFirstSocket = await connectSocket(aliceToken);
    const aliceSecondSocket = await connectSocket(aliceSecondToken);
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 3);

    const aliceFirstEvents: ConversationSettingsUpdatedEventPayload[] = [];
    const aliceSecondEvents: ConversationSettingsUpdatedEventPayload[] = [];
    const bobEvents: ConversationSettingsUpdatedEventPayload[] = [];
    aliceFirstSocket.on(CONVERSATION_SETTINGS_UPDATED_EVENT, (payload) =>
      aliceFirstEvents.push(payload as ConversationSettingsUpdatedEventPayload),
    );
    aliceSecondSocket.on(CONVERSATION_SETTINGS_UPDATED_EVENT, (payload) =>
      aliceSecondEvents.push(
        payload as ConversationSettingsUpdatedEventPayload,
      ),
    );
    bobSocket.on(CONVERSATION_SETTINGS_UPDATED_EVENT, (payload) =>
      bobEvents.push(payload as ConversationSettingsUpdatedEventPayload),
    );

    await request(app.getHttpServer())
      .patch(`/v1/conversations/${CONVERSATION_ID}/settings`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ archived: true, muted: false, pinned: true })
      .expect(HttpStatus.OK);
    await waitUntil(
      () => aliceFirstEvents.length === 1 && aliceSecondEvents.length === 1,
      'Expected conversation.settings.updated on both user sockets.',
    );

    const expectedEvent = {
      conversationId: CONVERSATION_ID,
      userId: ALICE_ID,
      archived: true,
      muted: false,
      pinned: true,
      archivedAt: clock.now().toISOString(),
      mutedAt: null,
      pinnedAt: clock.now().toISOString(),
      occurredAt: clock.now().toISOString(),
    };
    expect(aliceFirstEvents).toEqual([expectedEvent]);
    expect(aliceSecondEvents).toEqual([expectedEvent]);
    expect(bobEvents).toEqual([]);
  });

  it('lets a member send trimmed text without exposing internal routing or phone data', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, text: '  Hello Bob!  ' })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store')
      .expect('Pragma', 'no-cache');

    expect(response.body).toMatchObject({
      id: expect.any(String) as string,
      conversationId: CONVERSATION_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      senderId: ALICE_ID,
      kind: 'text',
      text: 'Hello Bob!',
      createdAt: expect.any(String) as string,
    });
    expect(response.body).not.toHaveProperty('participantIds');
    expect(JSON.stringify(response.body)).not.toContain('phoneNumber');
    expect(JSON.stringify(response.body)).not.toContain(ALICE_PHONE);
    expect(JSON.stringify(response.body)).not.toContain(BOB_PHONE);
    expect(messagingRepository.messageCount).toBe(1);
  });

  it.each([
    ['a PostgreSQL null character', `hello\u0000world`],
    ['more than 4000 PostgreSQL code points', '✈️'.repeat(3000)],
  ])('rejects %s before persistence', async (_label, text) => {
    const response = await request(app.getHttpServer())
      .post(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, text })
      .expect(HttpStatus.BAD_REQUEST);

    expect(response.body as ApiErrorBody).toMatchObject({
      statusCode: HttpStatus.BAD_REQUEST,
      code: 'VALIDATION_ERROR',
    });
    expect(messagingRepository.messageCount).toBe(0);
  });

  it('rejects an idempotency key reused with different text or conversation data', async () => {
    await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Original text',
    );

    const differentText = await request(app.getHttpServer())
      .post(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, text: 'Different text' })
      .expect(HttpStatus.CONFLICT);
    const differentConversation = await request(app.getHttpServer())
      .post(`/v1/conversations/${SECOND_CONVERSATION_ID}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ clientMessageId: CLIENT_MESSAGE_ID, text: 'Original text' })
      .expect(HttpStatus.CONFLICT);

    for (const response of [differentText, differentConversation]) {
      expect(response.body as ApiErrorBody).toMatchObject({
        statusCode: HttpStatus.CONFLICT,
        code: 'MESSAGE_IDEMPOTENCY_CONFLICT',
        message:
          'The client message ID has already been used with different message data.',
      });
    }
    expect(messagingRepository.messageCount).toBe(1);
  });

  it('returns the same indistinguishable 404 to an outsider for send, history, and read', async () => {
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(`/v1/conversations/${CONVERSATION_ID}/messages`)
        .set('Authorization', `Bearer ${carolToken}`)
        .send({ clientMessageId: CLIENT_MESSAGE_ID, text: 'Not allowed' })
        .expect(HttpStatus.NOT_FOUND),
      request(app.getHttpServer())
        .get(`/v1/conversations/${CONVERSATION_ID}/messages`)
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(HttpStatus.NOT_FOUND),
      request(app.getHttpServer())
        .post(`/v1/conversations/${CONVERSATION_ID}/read`)
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(HttpStatus.NOT_FOUND),
    ]);

    for (const response of responses) {
      expect(response.body as ApiErrorBody).toMatchObject({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'CONVERSATION_NOT_FOUND',
        message: 'The conversation was not found.',
      });
    }
  });

  it('returns newest-first message history with stable cursor pagination', async () => {
    const first = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'First',
    );
    clock.advanceSeconds(1);
    const second = await sendMessage(
      bobToken,
      CONVERSATION_ID,
      SECOND_CLIENT_MESSAGE_ID,
      'Second',
    );
    clock.advanceSeconds(1);
    const third = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      THIRD_CLIENT_MESSAGE_ID,
      'Third',
    );

    const firstPageResponse = await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .query({ limit: 2 })
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    const firstPage = firstPageResponse.body as MessageHistoryBody;
    expect(firstPage.items.map((message) => message.id)).toEqual([
      third.id,
      second.id,
    ]);
    expect(firstPage.pageInfo).toEqual({
      nextCursor: expect.any(String) as string,
      hasNextPage: true,
    });

    const secondPageResponse = await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .query({ limit: 2, cursor: firstPage.pageInfo.nextCursor })
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    const secondPage = secondPageResponse.body as MessageHistoryBody;
    expect(secondPage.items.map((message) => message.id)).toEqual([first.id]);
    expect(secondPage.pageInfo).toEqual({
      nextCursor: null,
      hasNextPage: false,
    });
    expect(JSON.stringify([firstPage, secondPage])).not.toContain(
      'phoneNumber',
    );
  });

  it('increments recipient unread state and resets it when the recipient marks the conversation read', async () => {
    await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Unread one',
    );
    clock.advanceSeconds(1);
    const latest = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      SECOND_CLIENT_MESSAGE_ID,
      'Unread two',
    );

    const bobBeforeRead = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(bobBeforeRead.body).toMatchObject({
      items: [
        {
          id: CONVERSATION_ID,
          unreadCount: 2,
          latestMessage: {
            id: latest.id,
            senderId: ALICE_ID,
            kind: 'text',
            preview: 'Unread two',
          },
        },
      ],
    });

    const aliceList = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    const aliceConversation = (
      aliceList.body as { items: Array<{ id: string; unreadCount: number }> }
    ).items.find((conversation) => conversation.id === CONVERSATION_ID);
    expect(aliceConversation?.unreadCount).toBe(0);

    const readResponse = await request(app.getHttpServer())
      .post(`/v1/conversations/${CONVERSATION_ID}/read`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(readResponse.body).toEqual({
      conversationId: CONVERSATION_ID,
      lastReadAt: expect.any(String) as string,
      unreadCount: 0,
    });

    const bobAfterRead = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(bobAfterRead.body).toMatchObject({
      items: [{ id: CONVERSATION_ID, unreadCount: 0 }],
    });
    expect(JSON.stringify(bobAfterRead.body)).not.toContain('phoneNumber');
  });

  it('delivers exactly one message.created event to both participants and every sender device', async () => {
    const aliceFirstSocket = await connectSocket(aliceToken);
    const aliceSecondSocket = await connectSocket(aliceSecondToken);
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 3);

    const aliceFirstEvents: MessageCreatedEventPayload[] = [];
    const aliceSecondEvents: MessageCreatedEventPayload[] = [];
    const bobEvents: MessageCreatedEventPayload[] = [];
    aliceFirstSocket.on(MESSAGE_CREATED_EVENT, (payload) =>
      aliceFirstEvents.push(payload as MessageCreatedEventPayload),
    );
    aliceSecondSocket.on(MESSAGE_CREATED_EVENT, (payload) =>
      aliceSecondEvents.push(payload as MessageCreatedEventPayload),
    );
    bobSocket.on(MESSAGE_CREATED_EVENT, (payload) =>
      bobEvents.push(payload as MessageCreatedEventPayload),
    );

    const created = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Realtime hello',
    );
    await waitUntil(
      () =>
        aliceFirstEvents.length === 1 &&
        aliceSecondEvents.length === 1 &&
        bobEvents.length === 1,
      'Expected message.created on every participant socket.',
    );

    const replay = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Realtime hello',
    );
    await delay(50);

    expect(replay.id).toBe(created.id);
    expect(aliceFirstEvents).toEqual([created]);
    expect(aliceSecondEvents).toEqual([created]);
    expect(bobEvents).toEqual([created]);
    expect(JSON.stringify(bobEvents)).not.toContain('phoneNumber');
    expect(messagingRepository.messageCount).toBe(1);
  });

  it('persists a monotonic delivery frontier and emits exactly once to every participant device', async () => {
    const first = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Delivery one',
    );
    clock.advanceSeconds(1);
    const second = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      SECOND_CLIENT_MESSAGE_ID,
      'Delivery two',
    );
    clock.advanceSeconds(1);

    const aliceFirstSocket = await connectSocket(aliceToken);
    const aliceSecondSocket = await connectSocket(aliceSecondToken);
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 3);
    const eventLists = [aliceFirstSocket, aliceSecondSocket, bobSocket].map(
      (socket) => {
        const events: ReceiptUpdatedEventPayload[] = [];
        socket.on(RECEIPT_DELIVERED_EVENT, (payload) =>
          events.push(payload as ReceiptUpdatedEventPayload),
        );
        return events;
      },
    );

    const updatedResponse = await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ throughMessageId: second.id })
      .expect(HttpStatus.OK)
      .expect('Cache-Control', 'no-store');
    const updated = updatedResponse.body as ReceiptUpdateBody;
    await waitUntil(
      () => eventLists.every((events) => events.length === 1),
      'Expected receipt.delivered on every participant socket.',
    );

    expect(updated).toEqual({
      conversationId: CONVERSATION_ID,
      status: 'delivered',
      throughMessageId: second.id,
      at: clock.now().toISOString(),
      changed: true,
      version: 1,
      unreadCount: 2,
      delivered: { messageId: second.id, at: clock.now().toISOString() },
      read: null,
    });
    const expectedEvent: ReceiptUpdatedEventPayload = {
      conversationId: CONVERSATION_ID,
      userId: BOB_ID,
      throughMessageId: second.id,
      at: clock.now().toISOString(),
      version: 1,
      delivered: { messageId: second.id, at: clock.now().toISOString() },
      read: null,
    };
    for (const events of eventLists) expect(events).toEqual([expectedEvent]);

    clock.advanceSeconds(1);
    const third = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      THIRD_CLIENT_MESSAGE_ID,
      'Delivery three',
    );
    clock.advanceSeconds(1);
    const advancedResponse = await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ throughMessageId: third.id })
      .expect(HttpStatus.OK);
    const advanced = advancedResponse.body as ReceiptUpdateBody;
    await waitUntil(
      () => eventLists.every((events) => events.length === 2),
      'Expected the advanced receipt.delivered event.',
    );
    expect(advanced).toMatchObject({
      throughMessageId: third.id,
      changed: true,
      version: 2,
      delivered: { messageId: third.id, at: advanced.at },
      read: null,
      unreadCount: 3,
    });
    const advancedEvent: ReceiptUpdatedEventPayload = {
      conversationId: CONVERSATION_ID,
      userId: BOB_ID,
      throughMessageId: third.id,
      at: advanced.at,
      version: 2,
      delivered: { messageId: third.id, at: advanced.at },
      read: null,
    };
    for (const events of eventLists) {
      expect(events).toEqual([expectedEvent, advancedEvent]);
    }

    const replay = await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ throughMessageId: third.id })
      .expect(HttpStatus.OK);
    const older = await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ throughMessageId: first.id })
      .expect(HttpStatus.OK);
    await delay(50);
    for (const response of [replay, older]) {
      expect(response.body as ReceiptUpdateBody).toMatchObject({
        status: 'delivered',
        throughMessageId: third.id,
        at: advanced.at,
        changed: false,
        version: 2,
        unreadCount: 3,
      });
    }
    for (const events of eventLists) {
      expect(events).toEqual([expectedEvent, advancedEvent]);
    }

    const reconciliationResponse = await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/receipts`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    const reconciliation = reconciliationResponse.body as ReceiptFrontiersBody;
    expect(reconciliation).toEqual({
      conversationId: CONVERSATION_ID,
      items: [
        { userId: ALICE_ID, version: 0, delivered: null, read: null },
        {
          userId: BOB_ID,
          version: 2,
          delivered: { messageId: third.id, at: advanced.at },
          read: null,
        },
      ],
    });
    expect(JSON.stringify(reconciliation)).not.toContain('phoneNumber');
  });

  it('makes a direct read imply delivery, clears unread state, and emits the read frontier once', async () => {
    await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Read one',
    );
    clock.advanceSeconds(1);
    const second = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      SECOND_CLIENT_MESSAGE_ID,
      'Read two',
    );
    clock.advanceSeconds(1);

    const aliceFirstSocket = await connectSocket(aliceToken);
    const aliceSecondSocket = await connectSocket(aliceSecondToken);
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 3);
    const eventLists = [aliceFirstSocket, aliceSecondSocket, bobSocket].map(
      (socket) => {
        const events: ReceiptUpdatedEventPayload[] = [];
        socket.on(RECEIPT_READ_EVENT, (payload) =>
          events.push(payload as ReceiptUpdatedEventPayload),
        );
        return events;
      },
    );

    const readResponse = await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/read`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ throughMessageId: second.id })
      .expect(HttpStatus.OK);
    const read = readResponse.body as ReceiptUpdateBody;
    await waitUntil(
      () => eventLists.every((events) => events.length === 1),
      'Expected receipt.read on every participant socket.',
    );
    expect(read).toEqual({
      conversationId: CONVERSATION_ID,
      status: 'read',
      throughMessageId: second.id,
      at: clock.now().toISOString(),
      changed: true,
      version: 1,
      unreadCount: 0,
      delivered: { messageId: second.id, at: clock.now().toISOString() },
      read: { messageId: second.id, at: clock.now().toISOString() },
    });

    const expectedEvent: ReceiptUpdatedEventPayload = {
      conversationId: CONVERSATION_ID,
      userId: BOB_ID,
      throughMessageId: second.id,
      at: read.at,
      version: 1,
      delivered: { messageId: second.id, at: read.at },
      read: { messageId: second.id, at: read.at },
    };
    for (const events of eventLists) expect(events).toEqual([expectedEvent]);

    const replay = await request(app.getHttpServer())
      .put(`/v1/conversations/${CONVERSATION_ID}/receipts/read`)
      .set('Authorization', `Bearer ${bobToken}`)
      .send({ throughMessageId: second.id })
      .expect(HttpStatus.OK);
    expect(replay.body as ReceiptUpdateBody).toMatchObject({
      throughMessageId: second.id,
      at: read.at,
      changed: false,
      version: 1,
      unreadCount: 0,
    });
    await delay(50);
    for (const events of eventLists) expect(events).toEqual([expectedEvent]);

    const reconciliationResponse = await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/receipts`)
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    const reconciliation = reconciliationResponse.body as ReceiptFrontiersBody;
    expect(reconciliation.items).toContainEqual({
      userId: BOB_ID,
      version: 1,
      delivered: { messageId: second.id, at: read.at },
      read: { messageId: second.id, at: read.at },
    });

    const conversations = await request(app.getHttpServer())
      .get('/v1/conversations')
      .set('Authorization', `Bearer ${bobToken}`)
      .expect(HttpStatus.OK);
    expect(conversations.body).toMatchObject({
      items: [{ id: CONVERSATION_ID, unreadCount: 0 }],
    });
  });

  it('conceals outsider, wrong-conversation, and sender-owned receipt boundaries behind the same 404', async () => {
    const incoming = await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Incoming for Bob',
    );
    const senderOwned = await sendMessage(
      bobToken,
      CONVERSATION_ID,
      SECOND_CLIENT_MESSAGE_ID,
      'Bob cannot receipt this',
    );
    const wrongConversation = await sendMessage(
      aliceToken,
      SECOND_CONVERSATION_ID,
      THIRD_CLIENT_MESSAGE_ID,
      'Different conversation',
    );

    const responses = await Promise.all([
      request(app.getHttpServer())
        .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
        .set('Authorization', `Bearer ${carolToken}`)
        .send({ throughMessageId: incoming.id })
        .expect(HttpStatus.NOT_FOUND),
      request(app.getHttpServer())
        .put(`/v1/conversations/${CONVERSATION_ID}/receipts/read`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ throughMessageId: wrongConversation.id })
        .expect(HttpStatus.NOT_FOUND),
      request(app.getHttpServer())
        .put(`/v1/conversations/${CONVERSATION_ID}/receipts/delivered`)
        .set('Authorization', `Bearer ${bobToken}`)
        .send({ throughMessageId: senderOwned.id })
        .expect(HttpStatus.NOT_FOUND),
      request(app.getHttpServer())
        .get(`/v1/conversations/${CONVERSATION_ID}/receipts`)
        .set('Authorization', `Bearer ${carolToken}`)
        .expect(HttpStatus.NOT_FOUND),
    ]);

    for (const response of responses) {
      expect(response.body as ApiErrorBody).toEqual({
        statusCode: HttpStatus.NOT_FOUND,
        code: 'CONVERSATION_NOT_FOUND',
        message: 'The conversation was not found.',
        timestamp: expect.any(String) as string,
        path: expect.any(String) as string,
      });
    }
  });

  it('returns an authorized conversation presence and active-typing snapshot', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 2);

    const typingAck = await emitWithAck<TypingStartedData>(
      aliceSocket,
      TYPING_START_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    expect(typingAck).toMatchObject({
      ok: true,
      data: {
        conversationId: CONVERSATION_ID,
        expiresAt: expect.any(String) as string,
      },
    });

    const presenceAck = await emitWithAck<PresenceSubscriptionData>(
      bobSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    expect(presenceAck).toEqual({
      ok: true,
      data: {
        conversationId: CONVERSATION_ID,
        participants: [
          { userId: ALICE_ID, status: 'online' },
          { userId: BOB_ID, status: 'online' },
        ],
        typing: [
          {
            userId: ALICE_ID,
            expiresAt:
              typingAck.ok && typingAck.data ? typingAck.data.expiresAt : '',
          },
        ],
      },
    });
  });

  it('returns the same conversation error to an outsider and for a missing conversation', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const carolSocket = await connectSocket(carolToken);

    const outsiderAck = await emitWithAck<PresenceSubscriptionData>(
      carolSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    const missingAck = await emitWithAck<PresenceSubscriptionData>(
      aliceSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: MISSING_CONVERSATION_ID },
    );

    const expectedError = {
      ok: false,
      error: {
        code: REALTIME_CONVERSATION_ERROR_CODE,
        message: REALTIME_CONVERSATION_ERROR_MESSAGE,
      },
    };
    expect(outsiderAck).toEqual(expectedError);
    expect(missingAck).toEqual(expectedError);
  });

  it('tracks presence across devices and delays the final offline transition', async () => {
    const aliceFirstSocket = await connectSocket(aliceToken);
    const aliceSecondSocket = await connectSocket(aliceSecondToken);
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 3);
    await emitWithAck<PresenceSubscriptionData>(
      bobSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: CONVERSATION_ID },
    );

    const presenceEvents: PresenceChangedEventPayload[] = [];
    bobSocket.on(PRESENCE_CHANGED_EVENT, (payload) =>
      presenceEvents.push(payload as PresenceChangedEventPayload),
    );

    aliceFirstSocket.disconnect();
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 2);
    await delay(25);
    expect(presenceEvents).toEqual([]);

    const timerSpy = shortenServerTimer(10_000, 100);
    aliceSecondSocket.disconnect();
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID], 1);
    await delay(25);
    expect(presenceEvents).toEqual([]);
    await waitUntil(
      () => presenceEvents.length === 1,
      'Expected the delayed offline presence event.',
    );
    timerSpy.mockRestore();

    expect(presenceEvents).toEqual([
      {
        conversationId: CONVERSATION_ID,
        userId: ALICE_ID,
        status: 'offline',
        occurredAt: clock.now().toISOString(),
      },
    ]);

    await connectSocket(aliceToken);
    await waitUntil(
      () => presenceEvents.length === 2,
      'Expected the online presence event after reconnecting.',
    );
    expect(presenceEvents[1]).toEqual({
      conversationId: CONVERSATION_ID,
      userId: ALICE_ID,
      status: 'online',
      occurredAt: clock.now().toISOString(),
    });
  });

  it('broadcasts typing refresh and stop only to subscribed peers', async () => {
    const aliceFirstSocket = await connectSocket(aliceToken);
    const aliceSecondSocket = await connectSocket(aliceSecondToken);
    const bobSocket = await connectSocket(bobToken);
    for (const socket of [aliceFirstSocket, aliceSecondSocket, bobSocket]) {
      await emitWithAck<PresenceSubscriptionData>(
        socket,
        PRESENCE_SUBSCRIBE_COMMAND,
        { conversationId: CONVERSATION_ID },
      );
    }

    const aliceFirstEvents: Array<
      TypingStartedEventPayload | TypingStoppedEventPayload
    > = [];
    const aliceSecondEvents: Array<
      TypingStartedEventPayload | TypingStoppedEventPayload
    > = [];
    const bobStarts: TypingStartedEventPayload[] = [];
    const bobStops: TypingStoppedEventPayload[] = [];
    for (const [socket, events] of [
      [aliceFirstSocket, aliceFirstEvents],
      [aliceSecondSocket, aliceSecondEvents],
    ] as const) {
      socket.on(TYPING_STARTED_EVENT, (payload) =>
        events.push(payload as TypingStartedEventPayload),
      );
      socket.on(TYPING_STOPPED_EVENT, (payload) =>
        events.push(payload as TypingStoppedEventPayload),
      );
    }
    bobSocket.on(TYPING_STARTED_EVENT, (payload) =>
      bobStarts.push(payload as TypingStartedEventPayload),
    );
    bobSocket.on(TYPING_STOPPED_EVENT, (payload) =>
      bobStops.push(payload as TypingStoppedEventPayload),
    );

    const firstAck = await emitWithAck<TypingStartedData>(
      aliceFirstSocket,
      TYPING_START_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    await waitUntil(
      () => bobStarts.length === 1,
      'Expected the first typing.started event.',
    );
    clock.advanceSeconds(1);
    const refreshedAck = await emitWithAck<TypingStartedData>(
      aliceFirstSocket,
      TYPING_START_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    await waitUntil(
      () => bobStarts.length === 2,
      'Expected the refreshed typing.started event.',
    );
    const stoppedAck = await emitWithAck<TypingStoppedData>(
      aliceFirstSocket,
      TYPING_STOP_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    await waitUntil(
      () => bobStops.length === 1,
      'Expected the explicit typing.stopped event.',
    );

    expect(firstAck).toMatchObject({ ok: true });
    expect(refreshedAck).toMatchObject({ ok: true });
    expect(stoppedAck).toEqual({
      ok: true,
      data: { conversationId: CONVERSATION_ID },
    });
    expect(
      refreshedAck.ok && firstAck.ok
        ? Date.parse(refreshedAck.data.expiresAt) -
            Date.parse(firstAck.data.expiresAt)
        : 0,
    ).toBe(1_000);
    expect(bobStarts).toEqual([
      {
        conversationId: CONVERSATION_ID,
        userId: ALICE_ID,
        expiresAt: firstAck.ok ? firstAck.data.expiresAt : '',
      },
      {
        conversationId: CONVERSATION_ID,
        userId: ALICE_ID,
        expiresAt: refreshedAck.ok ? refreshedAck.data.expiresAt : '',
      },
    ]);
    expect(bobStops).toEqual([
      {
        conversationId: CONVERSATION_ID,
        userId: ALICE_ID,
        occurredAt: clock.now().toISOString(),
      },
    ]);
    expect(aliceFirstEvents).toEqual([]);
    expect(aliceSecondEvents).toEqual([]);
  });

  it('automatically expires typing without waiting for the production TTL', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    await emitWithAck<PresenceSubscriptionData>(
      bobSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    const stoppedEvents: TypingStoppedEventPayload[] = [];
    bobSocket.on(TYPING_STOPPED_EVENT, (payload) =>
      stoppedEvents.push(payload as TypingStoppedEventPayload),
    );

    const timerSpy = shortenServerTimer(5_000, 100);
    const startedAck = await emitWithAck<TypingStartedData>(
      aliceSocket,
      TYPING_START_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    expect(startedAck).toMatchObject({ ok: true });
    await delay(25);
    expect(stoppedEvents).toEqual([]);
    await waitUntil(
      () => stoppedEvents.length === 1,
      'Expected typing to expire automatically.',
    );
    timerSpy.mockRestore();

    expect(stoppedEvents).toEqual([
      {
        conversationId: CONVERSATION_ID,
        userId: ALICE_ID,
        occurredAt: clock.now().toISOString(),
      },
    ]);
  });

  it.each([
    ['missing payload', undefined],
    ['invalid UUID', { conversationId: 'not-a-uuid' }],
    [
      'extra payload property',
      { conversationId: CONVERSATION_ID, targetUserId: BOB_ID },
    ],
  ])('rejects a realtime command with %s', async (_label, payload) => {
    const aliceSocket = await connectSocket(aliceToken);

    const ack = await emitWithAck<PresenceSubscriptionData>(
      aliceSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      payload,
    );

    expect(ack).toEqual({
      ok: false,
      error: {
        code: REALTIME_PAYLOAD_ERROR_CODE,
        message: REALTIME_PAYLOAD_ERROR_MESSAGE,
      },
    });
  });

  it('disconnects a revoked presence subscriber before a typing event is delivered', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    await emitWithAck<PresenceSubscriptionData>(
      bobSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    const bobEvents: TypingStartedEventPayload[] = [];
    bobSocket.on(TYPING_STARTED_EVENT, (payload) =>
      bobEvents.push(payload as TypingStartedEventPayload),
    );
    const disconnected = new Promise<void>((resolve) => {
      bobSocket.once('disconnect', () => resolve());
    });

    await authRepository.revokeSession(BOB_SESSION_ID, clock.now(), 'LOGOUT');
    const ack = await emitWithAck<TypingStartedData>(
      aliceSocket,
      TYPING_START_COMMAND,
      { conversationId: CONVERSATION_ID },
    );
    await disconnected;

    expect(ack).toMatchObject({ ok: true });
    expect(bobEvents).toEqual([]);
    expect(bobSocket.connected).toBe(false);
  });

  it.each([
    ['missing', undefined],
    ['invalid', 'not-a-valid-access-token'],
  ])(
    'rejects a socket with a %s access token using the stable auth error code',
    async (_label, token) => {
      const socket = createSocket(token);
      const error = await waitForConnectionError(socket);
      expect(error.message).toBe(REALTIME_AUTH_ERROR_MESSAGE);
      expect(error.data).toEqual({
        code: REALTIME_AUTH_ERROR_CODE,
        message: REALTIME_AUTH_ERROR_MESSAGE,
      });
      expect(socket.connected).toBe(false);
    },
  );

  it('disconnects a revoked active socket and does not deliver the next private event to it', async () => {
    const bobSocket = await connectSocket(bobToken);
    await waitForRoutedSocketCount([BOB_ID], 1);
    const bobEvents: MessageCreatedEventPayload[] = [];
    bobSocket.on(MESSAGE_CREATED_EVENT, (payload) =>
      bobEvents.push(payload as MessageCreatedEventPayload),
    );
    const disconnected = new Promise<void>((resolve) => {
      bobSocket.once('disconnect', () => resolve());
    });

    await authRepository.revokeSession(BOB_SESSION_ID, clock.now(), 'LOGOUT');
    await sendMessage(
      aliceToken,
      CONVERSATION_ID,
      CLIENT_MESSAGE_ID,
      'Private after revocation',
    );
    await disconnected;

    expect(bobEvents).toEqual([]);
    expect(bobSocket.connected).toBe(false);
  });

  it('does not accept message sending from a client socket event', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    await waitForRoutedSocketCount([ALICE_ID], 1);
    const createdEvents: MessageCreatedEventPayload[] = [];
    aliceSocket.on(MESSAGE_CREATED_EVENT, (payload) =>
      createdEvents.push(payload as MessageCreatedEventPayload),
    );

    aliceSocket.emit('message.send', {
      conversationId: CONVERSATION_ID,
      clientMessageId: CLIENT_MESSAGE_ID,
      text: 'This must not be persisted.',
    });
    await delay(50);

    const history = await request(app.getHttpServer())
      .get(`/v1/conversations/${CONVERSATION_ID}/messages`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.OK);
    expect(history.body).toEqual({
      items: [],
      pageInfo: { nextCursor: null, hasNextPage: false },
    });
    expect(createdEvents).toEqual([]);
    expect(messagingRepository.messageCount).toBe(0);
  });
});

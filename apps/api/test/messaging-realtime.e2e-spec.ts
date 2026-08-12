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
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationsRepository } from '../src/conversations/conversations.repository';
import { ConversationsService } from '../src/conversations/conversations.service';
import { MessageEventsPublisher } from '../src/messages/message-events.publisher';
import { MessagesController } from '../src/messages/messages.controller';
import { MessagesRepository } from '../src/messages/messages.repository';
import { MessagesService } from '../src/messages/messages.service';
import { ChatGateway } from '../src/realtime/chat.gateway';
import { RealtimeAuthenticator } from '../src/realtime/realtime-authenticator';
import { RealtimeIoAdapter } from '../src/realtime/realtime-io.adapter';
import { RealtimeMessageEventsPublisher } from '../src/realtime/realtime-message-events.publisher';
import {
  MESSAGE_CREATED_EVENT,
  REALTIME_AUTH_ERROR_CODE,
  REALTIME_AUTH_ERROR_MESSAGE,
  type MessageCreatedEventPayload,
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
      controllers: [MessagesController, ConversationsController],
      providers: [
        MessagesService,
        ConversationsService,
        AccessTokenService,
        NoStoreInterceptor,
        ChatGateway,
        RealtimeAuthenticator,
        RealtimeMessageEventsPublisher,
        {
          provide: MessageEventsPublisher,
          useExisting: RealtimeMessageEventsPublisher,
        },
        { provide: AuthRepository, useValue: authRepository },
        { provide: MessagesRepository, useValue: messagingRepository },
        { provide: ConversationsRepository, useValue: messagingRepository },
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

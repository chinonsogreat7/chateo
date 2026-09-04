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
import { ConversationEventsPublisher } from '../src/conversations/conversation-events.publisher';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationsRepository } from '../src/conversations/conversations.repository';
import { ConversationsService } from '../src/conversations/conversations.service';
import type {
  AddGroupMembersInput,
  AddGroupMembersResult,
  ConversationMemberRoleRecord,
  DeleteGroupInput,
  DeleteGroupResult,
  GroupConversationRecord,
  LeaveGroupInput,
  LeaveGroupResult,
  RemoveGroupMemberInput,
  RemoveGroupMemberResult,
  TransferGroupOwnershipInput,
  TransferGroupOwnershipResult,
  UpdateGroupInput,
  UpdateGroupMemberRoleInput,
  UpdateGroupMemberRoleResult,
  UpdateGroupResult,
} from '../src/conversations/conversations.types';
import { ChatGateway } from '../src/realtime/chat.gateway';
import { ChatStateService } from '../src/realtime/chat-state.service';
import { RealtimeAuthenticator } from '../src/realtime/realtime-authenticator';
import {
  RealtimeConversationsRepository,
  type RealtimeConversationAccess,
} from '../src/realtime/realtime-conversations.repository';
import { RealtimeConversationEventsPublisher } from '../src/realtime/realtime-conversation-events.publisher';
import { RealtimeIoAdapter } from '../src/realtime/realtime-io.adapter';
import {
  CONVERSATION_DELETED_EVENT,
  CONVERSATION_MEMBERS_ADDED_EVENT,
  CONVERSATION_MEMBER_REMOVED_EVENT,
  CONVERSATION_MEMBER_ROLE_UPDATED_EVENT,
  CONVERSATION_METADATA_UPDATED_EVENT,
  CONVERSATION_OWNER_TRANSFERRED_EVENT,
  PRESENCE_SUBSCRIBE_COMMAND,
  REALTIME_CONVERSATION_ERROR_CODE,
  REALTIME_CONVERSATION_ERROR_MESSAGE,
  TYPING_START_COMMAND,
  TYPING_STARTED_EVENT,
  TYPING_STOPPED_EVENT,
  type ConversationDeletedEventPayload,
  type ConversationMembersAddedEventPayload,
  type ConversationMemberRemovedEventPayload,
  type ConversationMemberRoleUpdatedEventPayload,
  type ConversationMetadataUpdatedEventPayload,
  type ConversationOwnerTransferredEventPayload,
  type PresenceSubscriptionData,
  type RealtimeAck,
  type TypingStartedData,
  type TypingStartedEventPayload,
  type TypingStoppedEventPayload,
} from '../src/realtime/realtime.types';
import {
  InMemoryAuthRepository,
  ManualClock,
} from './support/auth-test-doubles';

interface SeedGroupUser {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

interface StoredGroup {
  id: string;
  name: string;
  avatarUrl: string | null;
  members: Map<string, ConversationMemberRoleRecord>;
  createdAt: Date;
  updatedAt: Date;
}

class InMemoryGroupLifecycleRepository {
  private readonly users = new Map<string, SeedGroupUser>();
  private group: StoredGroup | null = null;

  seedUser(user: SeedGroupUser): void {
    this.users.set(user.id.toLowerCase(), {
      ...user,
      id: user.id.toLowerCase(),
    });
  }

  seedGroup(
    id: string,
    ownerId: string,
    memberIds: string[],
    createdAt: Date,
  ): void {
    const normalizedOwnerId = ownerId.toLowerCase();
    const members = new Map<string, ConversationMemberRoleRecord>([
      [normalizedOwnerId, 'OWNER'],
      ...memberIds.map(
        (memberId) =>
          [memberId.toLowerCase(), 'MEMBER'] as [
            string,
            ConversationMemberRoleRecord,
          ],
      ),
    ]);
    for (const memberId of members.keys()) {
      if (!this.users.has(memberId)) {
        throw new Error(`Group member ${memberId} is not seeded.`);
      }
    }
    this.group = {
      id: id.toLowerCase(),
      name: 'Socket Study Group',
      avatarUrl: null,
      members,
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    };
  }

  async addGroupMembers(
    input: AddGroupMembersInput,
  ): Promise<AddGroupMembersResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    const actorRole = group.members.get(input.actorId);
    if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') {
      return { status: 'forbidden' };
    }
    if (input.participantIds.some((id) => group.members.has(id))) {
      return { status: 'member-already-exists' };
    }
    if (group.members.size + input.participantIds.length > 100) {
      return { status: 'group-full' };
    }
    if (input.participantIds.some((id) => !this.users.has(id))) {
      return { status: 'participant-not-found' };
    }

    for (const participantId of input.participantIds) {
      group.members.set(participantId, 'MEMBER');
    }
    group.updatedAt = new Date(input.now);
    return {
      status: 'members-added',
      conversation: this.toConversation(group, input.actorId),
      eventRecipientIds: this.memberIds(group),
    };
  }

  async updateGroup(input: UpdateGroupInput): Promise<UpdateGroupResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    const actorRole = group.members.get(input.actorId);
    if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') {
      return { status: 'forbidden' };
    }

    const nameChanged = input.name !== undefined && input.name !== group.name;
    const avatarChanged =
      input.avatarUrl !== undefined && input.avatarUrl !== group.avatarUrl;
    if (nameChanged) group.name = input.name ?? group.name;
    if (avatarChanged) group.avatarUrl = input.avatarUrl ?? null;
    const changed = nameChanged || avatarChanged;
    if (changed) group.updatedAt = new Date(input.now);
    return {
      status: 'updated',
      changed,
      conversation: this.toConversation(group, input.actorId),
      eventRecipientIds: this.memberIds(group),
    };
  }

  async removeGroupMember(
    input: RemoveGroupMemberInput,
  ): Promise<RemoveGroupMemberResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    const actorRole = group.members.get(input.actorId);
    if (actorRole !== 'OWNER' && actorRole !== 'ADMIN') {
      return { status: 'forbidden' };
    }
    const targetRole = group.members.get(input.memberId);
    if (!targetRole) return { status: 'member-not-found' };
    if (targetRole === 'OWNER') return { status: 'owner-protected' };
    if (actorRole === 'ADMIN' && targetRole !== 'MEMBER') {
      return { status: 'forbidden' };
    }

    const eventRecipientIds = this.memberIds(group);
    group.members.delete(input.memberId);
    group.updatedAt = new Date(input.now);
    return {
      status: 'member-removed',
      conversation: this.toConversation(group, input.actorId),
      eventRecipientIds,
    };
  }

  async updateGroupMemberRole(
    input: UpdateGroupMemberRoleInput,
  ): Promise<UpdateGroupMemberRoleResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    if (group.members.get(input.actorId) !== 'OWNER') {
      return { status: 'forbidden' };
    }
    const targetRole = group.members.get(input.memberId);
    if (!targetRole) return { status: 'member-not-found' };
    if (targetRole === 'OWNER') return { status: 'owner-protected' };

    const changed = targetRole !== input.role;
    if (changed) {
      group.members.set(input.memberId, input.role);
      group.updatedAt = new Date(input.now);
    }
    return {
      status: 'role-updated',
      changed,
      conversation: this.toConversation(group, input.actorId),
      eventRecipientIds: this.memberIds(group),
    };
  }

  async transferGroupOwnership(
    input: TransferGroupOwnershipInput,
  ): Promise<TransferGroupOwnershipResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    if (group.members.get(input.actorId) !== 'OWNER') {
      return { status: 'forbidden' };
    }
    const targetRole = group.members.get(input.memberId);
    if (!targetRole) return { status: 'member-not-found' };

    const changed = input.actorId !== input.memberId;
    if (changed) {
      group.members.set(input.actorId, 'ADMIN');
      group.members.set(input.memberId, 'OWNER');
      group.updatedAt = new Date(input.now);
    }
    return {
      status: 'ownership-transferred',
      changed,
      conversation: this.toConversation(group, input.actorId),
      eventRecipientIds: this.memberIds(group),
    };
  }

  async leaveGroup(input: LeaveGroupInput): Promise<LeaveGroupResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    if (group.members.get(input.actorId) === 'OWNER') {
      return { status: 'owner-transfer-required' };
    }

    const eventRecipientIds = this.memberIds(group);
    group.members.delete(input.actorId);
    group.updatedAt = new Date(input.now);
    return { status: 'left', eventRecipientIds };
  }

  async deleteGroup(input: DeleteGroupInput): Promise<DeleteGroupResult> {
    const group = this.groupForActor(input.conversationId, input.actorId);
    if (!group) return { status: 'conversation-not-found' };
    if (group.members.get(input.actorId) !== 'OWNER') {
      return { status: 'forbidden' };
    }

    const eventRecipientIds = this.memberIds(group);
    this.group = null;
    return { status: 'deleted', eventRecipientIds };
  }

  async findAccessibleConversation(
    conversationId: string,
    userId: string,
  ): Promise<RealtimeConversationAccess | null> {
    const group = this.groupForActor(conversationId, userId);
    return group
      ? { conversationId: group.id, participantIds: this.memberIds(group) }
      : null;
  }

  async findGroupParticipantIds(
    conversationId: string,
  ): Promise<string[] | null> {
    const group = this.group;
    return group?.id === conversationId.toLowerCase()
      ? this.memberIds(group)
      : null;
  }

  private groupForActor(
    conversationId: string,
    actorId: string,
  ): StoredGroup | null {
    const group = this.group;
    return group?.id === conversationId.toLowerCase() &&
      group.members.has(actorId.toLowerCase())
      ? group
      : null;
  }

  private memberIds(group: StoredGroup): string[] {
    return [...group.members.keys()].sort();
  }

  private toConversation(
    group: StoredGroup,
    currentUserId: string,
  ): GroupConversationRecord {
    const role = group.members.get(currentUserId);
    if (!role) throw new Error('Current user is not a group member.');
    return {
      id: group.id,
      type: 'GROUP',
      name: group.name,
      avatarUrl: group.avatarUrl,
      participants: this.memberIds(group).map((memberId) => {
        const user = this.users.get(memberId);
        const memberRole = group.members.get(memberId);
        if (!user || !memberRole) {
          throw new Error('Group participant state is inconsistent.');
        }
        return { ...user, role: memberRole };
      }),
      role,
      latestMessage: null,
      unreadCount: 0,
      lastActivityAt: new Date(group.createdAt),
      createdAt: new Date(group.createdAt),
      updatedAt: new Date(group.updatedAt),
    };
  }
}

const ALICE_ID = '00000000-0000-4000-8000-000000000101';
const BOB_ID = '00000000-0000-4000-8000-000000000102';
const CAROL_ID = '00000000-0000-4000-8000-000000000103';
const DAVE_ID = '00000000-0000-4000-8000-000000000104';
const GROUP_ID = '00000000-0000-4000-8000-000000000401';
const ALICE_SESSION_ID = '00000000-0000-4000-8000-000000000201';
const BOB_SESSION_ID = '00000000-0000-4000-8000-000000000202';
const CAROL_SESSION_ID = '00000000-0000-4000-8000-000000000203';
const DAVE_SESSION_ID = '00000000-0000-4000-8000-000000000204';

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
    deviceName: 'Group lifecycle E2E device',
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

describe('Group lifecycle REST and realtime API (e2e, in memory)', () => {
  let app: INestApplication;
  let serverUrl: string;
  let clock: ManualClock;
  let authRepository: InMemoryAuthRepository;
  let groupRepository: InMemoryGroupLifecycleRepository;
  let chatGateway: ChatGateway;
  let aliceToken: string;
  let bobToken: string;
  let carolToken: string;
  let daveToken: string;
  let sockets: Socket[];

  beforeEach(async () => {
    const initialTime = new Date();
    clock = new ManualClock(initialTime);
    authRepository = new InMemoryAuthRepository();
    groupRepository = new InMemoryGroupLifecycleRepository();
    sockets = [];

    const alice = user(ALICE_ID, '+12025550101', 'Alice Johnson', initialTime);
    const bob = user(BOB_ID, '+12025550102', 'Bob Okafor', initialTime);
    const carol = user(CAROL_ID, '+12025550103', 'Carol Mensah', initialTime);
    const dave = user(DAVE_ID, '+12025550104', 'Dave Chen', initialTime);
    const users = [alice, bob, carol, dave];
    for (const record of users) {
      authRepository.seedUser(record);
      groupRepository.seedUser({
        id: record.id,
        displayName: record.displayName ?? 'Unknown',
        avatarUrl: record.avatarUrl,
      });
    }
    groupRepository.seedGroup(
      GROUP_ID,
      ALICE_ID,
      [BOB_ID, CAROL_ID],
      new Date(initialTime.getTime() - 60 * 60 * 1000),
    );

    const sessions = [
      session(ALICE_SESSION_ID, ALICE_ID, 'a', initialTime),
      session(BOB_SESSION_ID, BOB_ID, 'b', initialTime),
      session(CAROL_SESSION_ID, CAROL_ID, 'c', initialTime),
      session(DAVE_SESSION_ID, DAVE_ID, 'd', initialTime),
    ];
    for (const record of sessions) authRepository.seedSession(record);

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
      controllers: [ConversationsController],
      providers: [
        ConversationsService,
        AccessTokenService,
        NoStoreInterceptor,
        ChatGateway,
        ChatStateService,
        RealtimeAuthenticator,
        RealtimeConversationEventsPublisher,
        {
          provide: ConversationEventsPublisher,
          useExisting: RealtimeConversationEventsPublisher,
        },
        { provide: AuthRepository, useValue: authRepository },
        { provide: ConversationsRepository, useValue: groupRepository },
        {
          provide: RealtimeConversationsRepository,
          useValue: groupRepository,
        },
        { provide: Clock, useValue: clock },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();

    const accessTokens = moduleFixture.get(AccessTokenService);
    aliceToken = (await accessTokens.issue(alice, ALICE_SESSION_ID)).token;
    bobToken = (await accessTokens.issue(bob, BOB_SESSION_ID)).token;
    carolToken = (await accessTokens.issue(carol, CAROL_SESSION_ID)).token;
    daveToken = (await accessTokens.issue(dave, DAVE_SESSION_ID)).token;
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

  function createSocket(token: string): Socket {
    const socket = io(`${serverUrl}/chat`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      timeout: 2_000,
      transports: ['websocket'],
      auth: { token },
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

  async function subscribe(socket: Socket): Promise<void> {
    const result = await emitWithAck<PresenceSubscriptionData>(
      socket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: GROUP_ID },
    );
    expect(result).toMatchObject({ ok: true });
  }

  it('updates metadata through REST and publishes the exact change to every current member only', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    const carolSocket = await connectSocket(carolToken);
    const daveSocket = await connectSocket(daveToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID, CAROL_ID, DAVE_ID], 4);

    const eventLists = [aliceSocket, bobSocket, carolSocket, daveSocket].map(
      (socket) => {
        const events: ConversationMetadataUpdatedEventPayload[] = [];
        socket.on(CONVERSATION_METADATA_UPDATED_EVENT, (payload) =>
          events.push(payload as ConversationMetadataUpdatedEventPayload),
        );
        return events;
      },
    );

    const response = await request(app.getHttpServer())
      .patch(`/v1/conversations/${GROUP_ID}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({
        name: 'Realtime Project Team',
        avatarUrl: 'https://example.com/project-team.jpg',
      })
      .expect(HttpStatus.OK);
    await waitUntil(
      () => eventLists.slice(0, 3).every((events) => events.length === 1),
      'Expected conversation.metadata.updated on every current member socket.',
    );

    expect(response.body).toMatchObject({
      id: GROUP_ID,
      type: 'group',
      name: 'Realtime Project Team',
      avatarUrl: 'https://example.com/project-team.jpg',
      role: 'owner',
    });
    const expectedEvent: ConversationMetadataUpdatedEventPayload = {
      conversationId: GROUP_ID,
      actorId: ALICE_ID,
      name: 'Realtime Project Team',
      avatarUrl: 'https://example.com/project-team.jpg',
      occurredAt: clock.now().toISOString(),
    };
    for (const events of eventLists.slice(0, 3)) {
      expect(events).toEqual([expectedEvent]);
    }
    expect(eventLists[3]).toEqual([]);
  });

  it('updates a member role through REST and publishes the exact change to every current member only', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    const carolSocket = await connectSocket(carolToken);
    const daveSocket = await connectSocket(daveToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID, CAROL_ID, DAVE_ID], 4);

    const eventLists = [aliceSocket, bobSocket, carolSocket, daveSocket].map(
      (socket) => {
        const events: ConversationMemberRoleUpdatedEventPayload[] = [];
        socket.on(CONVERSATION_MEMBER_ROLE_UPDATED_EVENT, (payload) =>
          events.push(payload as ConversationMemberRoleUpdatedEventPayload),
        );
        return events;
      },
    );

    const response = await request(app.getHttpServer())
      .patch(`/v1/conversations/${GROUP_ID}/members/${BOB_ID}/role`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ role: 'admin' })
      .expect(HttpStatus.OK);
    await waitUntil(
      () => eventLists.slice(0, 3).every((events) => events.length === 1),
      'Expected conversation.member.role.updated on every current member socket.',
    );

    expect(response.body).toMatchObject({
      id: GROUP_ID,
      type: 'group',
      role: 'owner',
      participants: expect.arrayContaining([
        expect.objectContaining({ id: ALICE_ID, role: 'owner' }),
        expect.objectContaining({ id: BOB_ID, role: 'admin' }),
        expect.objectContaining({ id: CAROL_ID, role: 'member' }),
      ]) as unknown,
    });
    const expectedEvent: ConversationMemberRoleUpdatedEventPayload = {
      conversationId: GROUP_ID,
      actorId: ALICE_ID,
      memberId: BOB_ID,
      role: 'admin',
      occurredAt: clock.now().toISOString(),
    };
    for (const events of eventLists.slice(0, 3)) {
      expect(events).toEqual([expectedEvent]);
    }
    expect(eventLists[3]).toEqual([]);
  });

  it('transfers ownership through REST and publishes the exact change to every current member only', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    const carolSocket = await connectSocket(carolToken);
    const daveSocket = await connectSocket(daveToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID, CAROL_ID, DAVE_ID], 4);

    const eventLists = [aliceSocket, bobSocket, carolSocket, daveSocket].map(
      (socket) => {
        const events: ConversationOwnerTransferredEventPayload[] = [];
        socket.on(CONVERSATION_OWNER_TRANSFERRED_EVENT, (payload) =>
          events.push(payload as ConversationOwnerTransferredEventPayload),
        );
        return events;
      },
    );

    const response = await request(app.getHttpServer())
      .post(`/v1/conversations/${GROUP_ID}/transfer-ownership`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ newOwnerId: BOB_ID })
      .expect(HttpStatus.OK);
    await waitUntil(
      () => eventLists.slice(0, 3).every((events) => events.length === 1),
      'Expected conversation.owner.transferred on every current member socket.',
    );

    expect(response.body).toMatchObject({
      id: GROUP_ID,
      type: 'group',
      role: 'admin',
      participants: expect.arrayContaining([
        expect.objectContaining({ id: ALICE_ID, role: 'admin' }),
        expect.objectContaining({ id: BOB_ID, role: 'owner' }),
        expect.objectContaining({ id: CAROL_ID, role: 'member' }),
      ]) as unknown,
    });
    const expectedEvent: ConversationOwnerTransferredEventPayload = {
      conversationId: GROUP_ID,
      actorId: ALICE_ID,
      previousOwnerId: ALICE_ID,
      newOwnerId: BOB_ID,
      occurredAt: clock.now().toISOString(),
    };
    for (const events of eventLists.slice(0, 3)) {
      expect(events).toEqual([expectedEvent]);
    }
    expect(eventLists[3]).toEqual([]);
  });

  it('adds a member through REST, publishes to the post-mutation roster, and grants realtime access', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    const carolSocket = await connectSocket(carolToken);
    const daveSocket = await connectSocket(daveToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID, CAROL_ID, DAVE_ID], 4);
    await Promise.all(
      [aliceSocket, bobSocket, carolSocket].map((socket) => subscribe(socket)),
    );

    const deniedBeforeAdd = await emitWithAck<PresenceSubscriptionData>(
      daveSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: GROUP_ID },
    );
    expect(deniedBeforeAdd).toEqual({
      ok: false,
      error: {
        code: REALTIME_CONVERSATION_ERROR_CODE,
        message: REALTIME_CONVERSATION_ERROR_MESSAGE,
      },
    });

    const eventLists = [aliceSocket, bobSocket, carolSocket, daveSocket].map(
      (socket) => {
        const events: ConversationMembersAddedEventPayload[] = [];
        socket.on(CONVERSATION_MEMBERS_ADDED_EVENT, (payload) =>
          events.push(payload as ConversationMembersAddedEventPayload),
        );
        return events;
      },
    );

    const response = await request(app.getHttpServer())
      .post(`/v1/conversations/${GROUP_ID}/members`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .send({ participantIds: [DAVE_ID] })
      .expect(HttpStatus.OK);
    await waitUntil(
      () => eventLists.every((events) => events.length === 1),
      'Expected conversation.members.added on every post-mutation member socket.',
    );

    const expectedEvent: ConversationMembersAddedEventPayload = {
      conversationId: GROUP_ID,
      actorId: ALICE_ID,
      memberIds: [DAVE_ID],
      occurredAt: clock.now().toISOString(),
    };
    for (const events of eventLists) expect(events).toEqual([expectedEvent]);
    expect(response.body).toMatchObject({
      id: GROUP_ID,
      type: 'group',
      participants: expect.arrayContaining([
        expect.objectContaining({ id: DAVE_ID, role: 'member' }),
      ]) as unknown,
    });

    const allowedAfterAdd = await emitWithAck<PresenceSubscriptionData>(
      daveSocket,
      PRESENCE_SUBSCRIBE_COMMAND,
      { conversationId: GROUP_ID },
    );
    expect(allowedAfterAdd).toMatchObject({
      ok: true,
      data: {
        conversationId: GROUP_ID,
        participants: expect.arrayContaining([
          expect.objectContaining({ userId: ALICE_ID }),
          expect.objectContaining({ userId: BOB_ID }),
          expect.objectContaining({ userId: CAROL_ID }),
          expect.objectContaining({ userId: DAVE_ID }),
        ]) as unknown,
      },
    });
  });

  it.each([
    ['removed', 'owner removes a member'],
    ['left', 'member leaves'],
  ] as const)(
    'publishes a %s tombstone and evicts cached subscription and typing state when the %s',
    async (reason, _description) => {
      const aliceSocket = await connectSocket(aliceToken);
      const bobSocket = await connectSocket(bobToken);
      const carolSocket = await connectSocket(carolToken);
      const daveSocket = await connectSocket(daveToken);
      await waitForRoutedSocketCount([ALICE_ID, BOB_ID, CAROL_ID, DAVE_ID], 4);
      await Promise.all(
        [aliceSocket, bobSocket, carolSocket].map((socket) =>
          subscribe(socket),
        ),
      );

      const initialTypingEvents: TypingStartedEventPayload[][] = [
        aliceSocket,
        carolSocket,
      ].map((socket) => {
        const events: TypingStartedEventPayload[] = [];
        socket.on(TYPING_STARTED_EVENT, (payload) =>
          events.push(payload as TypingStartedEventPayload),
        );
        return events;
      });
      const bobStarted = await emitWithAck<TypingStartedData>(
        bobSocket,
        TYPING_START_COMMAND,
        { conversationId: GROUP_ID },
      );
      expect(bobStarted).toMatchObject({ ok: true });
      await waitUntil(
        () => initialTypingEvents.every((events) => events.length === 1),
        'Expected the initial typing event on current member subscriptions.',
      );

      const stoppedEventLists: TypingStoppedEventPayload[][] = [
        aliceSocket,
        carolSocket,
      ].map((socket) => {
        const events: TypingStoppedEventPayload[] = [];
        socket.on(TYPING_STOPPED_EVENT, (payload) =>
          events.push(payload as TypingStoppedEventPayload),
        );
        return events;
      });
      const tombstoneLists = [
        aliceSocket,
        bobSocket,
        carolSocket,
        daveSocket,
      ].map((socket) => {
        const events: ConversationMemberRemovedEventPayload[] = [];
        socket.on(CONVERSATION_MEMBER_REMOVED_EVENT, (payload) =>
          events.push(payload as ConversationMemberRemovedEventPayload),
        );
        return events;
      });

      if (reason === 'removed') {
        await request(app.getHttpServer())
          .delete(`/v1/conversations/${GROUP_ID}/members/${BOB_ID}`)
          .set('Authorization', `Bearer ${aliceToken}`)
          .expect(HttpStatus.NO_CONTENT);
      } else {
        await request(app.getHttpServer())
          .post(`/v1/conversations/${GROUP_ID}/leave`)
          .set('Authorization', `Bearer ${bobToken}`)
          .expect(HttpStatus.NO_CONTENT);
      }
      await waitUntil(
        () => tombstoneLists.slice(0, 3).every((events) => events.length === 1),
        'Expected the departure tombstone on every pre-mutation member socket.',
      );

      const expectedTombstone: ConversationMemberRemovedEventPayload = {
        conversationId: GROUP_ID,
        actorId: reason === 'removed' ? ALICE_ID : BOB_ID,
        memberId: BOB_ID,
        reason,
        occurredAt: clock.now().toISOString(),
      };
      for (const events of tombstoneLists.slice(0, 3)) {
        expect(events).toEqual([expectedTombstone]);
      }
      expect(tombstoneLists[3]).toEqual([]);

      await delay(50);
      for (const events of stoppedEventLists) expect(events).toEqual([]);

      const bobPostRemovalTypingEvents: TypingStartedEventPayload[] = [];
      const carolPostRemovalTypingEvents: TypingStartedEventPayload[] = [];
      bobSocket.on(TYPING_STARTED_EVENT, (payload) =>
        bobPostRemovalTypingEvents.push(payload as TypingStartedEventPayload),
      );
      carolSocket.on(TYPING_STARTED_EVENT, (payload) =>
        carolPostRemovalTypingEvents.push(payload as TypingStartedEventPayload),
      );

      const aliceStarted = await emitWithAck<TypingStartedData>(
        aliceSocket,
        TYPING_START_COMMAND,
        { conversationId: GROUP_ID },
      );
      expect(aliceStarted).toMatchObject({ ok: true });
      await waitUntil(
        () => carolPostRemovalTypingEvents.length === 1,
        'Expected typing to remain visible to current members.',
      );
      await delay(50);
      expect(bobPostRemovalTypingEvents).toEqual([]);

      const bobDenied = await emitWithAck<TypingStartedData>(
        bobSocket,
        TYPING_START_COMMAND,
        { conversationId: GROUP_ID },
      );
      expect(bobDenied).toEqual({
        ok: false,
        error: {
          code: REALTIME_CONVERSATION_ERROR_CODE,
          message: REALTIME_CONVERSATION_ERROR_MESSAGE,
        },
      });
    },
  );

  it('publishes deletion tombstones to the former roster after evicting cached access', async () => {
    const aliceSocket = await connectSocket(aliceToken);
    const bobSocket = await connectSocket(bobToken);
    const carolSocket = await connectSocket(carolToken);
    const daveSocket = await connectSocket(daveToken);
    await waitForRoutedSocketCount([ALICE_ID, BOB_ID, CAROL_ID, DAVE_ID], 4);
    await Promise.all(
      [aliceSocket, bobSocket, carolSocket].map((socket) => subscribe(socket)),
    );

    const tombstoneLists = [
      aliceSocket,
      bobSocket,
      carolSocket,
      daveSocket,
    ].map((socket) => {
      const events: ConversationDeletedEventPayload[] = [];
      socket.on(CONVERSATION_DELETED_EVENT, (payload) =>
        events.push(payload as ConversationDeletedEventPayload),
      );
      return events;
    });

    await request(app.getHttpServer())
      .delete(`/v1/conversations/${GROUP_ID}`)
      .set('Authorization', `Bearer ${aliceToken}`)
      .expect(HttpStatus.NO_CONTENT);
    await waitUntil(
      () => tombstoneLists.slice(0, 3).every((events) => events.length === 1),
      'Expected conversation.deleted on every former member socket.',
    );

    const expectedEvent: ConversationDeletedEventPayload = {
      conversationId: GROUP_ID,
      actorId: ALICE_ID,
      occurredAt: clock.now().toISOString(),
    };
    for (const events of tombstoneLists.slice(0, 3)) {
      expect(events).toEqual([expectedEvent]);
    }
    expect(tombstoneLists[3]).toEqual([]);

    for (const socket of [aliceSocket, bobSocket, carolSocket]) {
      const denied = await emitWithAck<PresenceSubscriptionData>(
        socket,
        PRESENCE_SUBSCRIBE_COMMAND,
        { conversationId: GROUP_ID },
      );
      expect(denied).toEqual({
        ok: false,
        error: {
          code: REALTIME_CONVERSATION_ERROR_CODE,
          message: REALTIME_CONVERSATION_ERROR_MESSAGE,
        },
      });
    }
  });
});

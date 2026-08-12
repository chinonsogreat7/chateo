import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { DiscoveryController } from './discovery/discovery.controller';
import { DiscoveryService } from './discovery/discovery.service';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { ReceiptsController } from './receipts/receipts.controller';
import { ReceiptsService } from './receipts/receipts.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

const CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const REFRESH_TOKEN =
  '550e8400-e29b-41d4-a716-446655440000.3fQ8xZ7uV2nK5mP9rT4wY6aB1cD0eF8gH2jL7sN5qRk';
const PARTICIPANT_ID = '7d444840-9dc0-11d1-b245-5ffdce74fad2';
const CLIENT_MESSAGE_ID = '7d444840-9dc0-41d1-b245-5ffdce74fad2';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const REPLY_TO_MESSAGE_ID = '55555555-5555-4555-8555-555555555555';

interface RequestExampleCase {
  method: 'patch' | 'post' | 'put';
  path: string;
  payload: Record<string, unknown>;
  schemaName: string;
}

describe('OpenAPI request examples', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        AuthController,
        UsersController,
        DiscoveryController,
        ConversationsController,
        MessagesController,
        ReceiptsController,
      ],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: DiscoveryService, useValue: {} },
        { provide: ConversationsService, useValue: {} },
        { provide: MessagesService, useValue: {} },
        { provide: ReceiptsService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ChatMe API')
        .setDescription('Phone authentication and chat backend API')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
      {
        operationIdFactory: (_controllerKey, methodKey) => methodKey,
      },
    );
  });

  afterAll(async () => {
    await app.close();
  });

  const cases: RequestExampleCase[] = [
    {
      method: 'post',
      path: '/v1/auth/otp/request',
      schemaName: 'RequestOtpDto',
      payload: { phoneNumber: '+2348012345678' },
    },
    {
      method: 'post',
      path: '/v1/auth/otp/resend',
      schemaName: 'ResendOtpDto',
      payload: { challengeId: CHALLENGE_ID },
    },
    {
      method: 'post',
      path: '/v1/auth/otp/verify',
      schemaName: 'VerifyOtpDto',
      payload: {
        challengeId: CHALLENGE_ID,
        code: '1234',
        device: { name: "Student's iPhone", platform: 'ios' },
      },
    },
    {
      method: 'post',
      path: '/v1/auth/refresh',
      schemaName: 'RefreshTokenDto',
      payload: { refreshToken: REFRESH_TOKEN },
    },
    {
      method: 'post',
      path: '/v1/auth/logout',
      schemaName: 'RefreshTokenDto',
      payload: { refreshToken: REFRESH_TOKEN },
    },
    {
      method: 'patch',
      path: '/v1/me',
      schemaName: 'UpdateProfileDto',
      payload: {
        displayName: 'Great Ichoku',
        avatarUrl: 'https://example.com/avatars/great.jpg',
      },
    },
    {
      method: 'post',
      path: '/v1/contacts/match',
      schemaName: 'MatchContactsDto',
      payload: {
        phoneNumbers: ['+234 801 234 5678', '+2348098765432'],
      },
    },
    {
      method: 'post',
      path: '/v1/conversations/direct',
      schemaName: 'CreateDirectConversationDto',
      payload: { participantId: PARTICIPANT_ID },
    },
    {
      method: 'post',
      path: `/v1/conversations/{conversationId}/messages`,
      schemaName: 'SendMessageDto',
      payload: {
        clientMessageId: CLIENT_MESSAGE_ID,
        text: 'Hello! Are you free to chat?',
      },
    },
    {
      method: 'put',
      path: `/v1/conversations/{conversationId}/receipts/delivered`,
      schemaName: 'UpdateReceiptDto',
      payload: { throughMessageId: MESSAGE_ID },
    },
    {
      method: 'put',
      path: `/v1/conversations/{conversationId}/receipts/read`,
      schemaName: 'UpdateReceiptDto',
      payload: { throughMessageId: MESSAGE_ID },
    },
  ];

  it.each(cases)(
    '$method $path exposes a complete JSON request example',
    ({ method, path, payload, schemaName }) => {
      const requestBody = document.paths[path]?.[method]?.requestBody;
      expect(requestBody).toBeDefined();
      if (!requestBody || '$ref' in requestBody) {
        throw new Error(`Missing inline request body for ${method} ${path}`);
      }

      const media = requestBody.content['application/json'];
      expect(media?.schema).toEqual({
        $ref: `#/components/schemas/${schemaName}`,
      });

      const example = media?.examples?.default;
      expect(example).toBeDefined();
      if (!example || '$ref' in example) {
        throw new Error(`Missing inline request example for ${method} ${path}`);
      }

      expect(example.value).toEqual(payload);
    },
  );

  it('documents nullable avatar URLs as strings', () => {
    expect(document.components?.schemas?.UpdateProfileDto).toMatchObject({
      properties: {
        avatarUrl: {
          type: 'string',
          nullable: true,
          format: 'uri',
        },
      },
    });
  });

  it('documents the durable receipt boundary as a required UUID', () => {
    expect(document.components?.schemas?.UpdateReceiptDto).toMatchObject({
      required: ['throughMessageId'],
      properties: {
        throughMessageId: {
          type: 'string',
          format: 'uuid',
          example: MESSAGE_ID,
        },
      },
    });
  });

  it('documents reply targets as optional UUIDs', () => {
    expect(document.components?.schemas?.SendMessageDto).toMatchObject({
      required: expect.arrayContaining(['clientMessageId', 'text']),
      properties: {
        replyToMessageId: {
          type: 'string',
          format: 'uuid',
          example: REPLY_TO_MESSAGE_ID,
        },
      },
    });
    expect(
      (document.components?.schemas?.SendMessageDto as { required?: string[] })
        .required,
    ).not.toContain('replyToMessageId');

    const requestBody =
      document.paths['/v1/conversations/{conversationId}/messages']?.post
        ?.requestBody;
    if (!requestBody || '$ref' in requestBody) {
      throw new Error('Missing inline message request body.');
    }
    const replyExample =
      requestBody.content['application/json']?.examples?.reply;
    if (!replyExample || '$ref' in replyExample) {
      throw new Error('Missing inline reply request example.');
    }
    expect(replyExample.value).toEqual({
      clientMessageId: '7d444840-9dc0-41d1-b245-5ffdce74fad3',
      replyToMessageId: REPLY_TO_MESSAGE_ID,
      text: 'Yes, I am free now.',
    });

    expect(document.components?.schemas?.MessageResponseDto).toMatchObject({
      required: expect.arrayContaining(['replyToMessageId', 'replyTo']),
      properties: {
        replyToMessageId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },
        replyTo: {
          nullable: true,
          allOf: [{ $ref: '#/components/schemas/MessageReplyResponseDto' }],
        },
      },
    });
    const replySchema = document.components?.schemas?.MessageReplyResponseDto;
    expect(replySchema).toMatchObject({
      required: ['id', 'senderId', 'kind', 'preview'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        senderId: { type: 'string', format: 'uuid' },
        kind: { type: 'string', enum: ['text'] },
        preview: { type: 'string', maxLength: 120 },
      },
    });
    expect(
      (replySchema as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty('text');
  });

  it.each(['PublicDiscoveryUserDto', 'ConversationParticipantDto'])(
    '%s exposes public profile fields without a phone number',
    (schemaName) => {
      const schema = document.components?.schemas?.[schemaName];
      expect(schema).toMatchObject({
        required: expect.arrayContaining(['id', 'displayName', 'avatarUrl']),
        properties: {
          id: expect.any(Object) as object,
          displayName: expect.any(Object) as object,
          avatarUrl: expect.any(Object) as object,
        },
      });
      expect(schema).not.toMatchObject({
        properties: { phoneNumber: expect.anything() },
      });
    },
  );

  it.each([
    ['/v1/contacts/match', 'post'],
    ['/v1/users/search', 'get'],
    ['/v1/conversations/direct', 'post'],
    ['/v1/conversations', 'get'],
    ['/v1/conversations/{conversationId}', 'get'],
    ['/v1/conversations/{conversationId}/messages', 'post'],
    ['/v1/conversations/{conversationId}/messages', 'get'],
    ['/v1/conversations/{conversationId}/read', 'post'],
    ['/v1/conversations/{conversationId}/receipts/delivered', 'put'],
    ['/v1/conversations/{conversationId}/receipts/read', 'put'],
    ['/v1/conversations/{conversationId}/receipts', 'get'],
  ] as const)('%s requires bearer authentication', (path, method) => {
    expect(document.paths[path]?.[method]?.security).toEqual([{ bearer: [] }]);
  });

  it('documents the message conversation path parameter', () => {
    const parameter = document.paths[
      '/v1/conversations/{conversationId}/messages'
    ]?.post?.parameters?.find(
      (candidate) =>
        !('$ref' in candidate) && candidate.name === 'conversationId',
    );
    expect(parameter).toMatchObject({
      in: 'path',
      required: true,
      schema: { format: 'uuid', type: 'string' },
    });
  });

  it.each([
    ['/v1/conversations/{conversationId}/receipts/delivered', 'put'],
    ['/v1/conversations/{conversationId}/receipts/read', 'put'],
    ['/v1/conversations/{conversationId}/receipts', 'get'],
  ] as const)(
    '%s documents the receipt conversation path parameter',
    (path, method) => {
      const parameter = document.paths[path]?.[method]?.parameters?.find(
        (candidate) =>
          !('$ref' in candidate) && candidate.name === 'conversationId',
      );
      expect(parameter).toMatchObject({
        in: 'path',
        required: true,
        schema: { format: 'uuid', type: 'string' },
      });
    },
  );
});

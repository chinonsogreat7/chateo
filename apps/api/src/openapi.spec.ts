import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { BlocksController } from './blocks/blocks.controller';
import { BlocksService } from './blocks/blocks.service';
import { ConversationSettingsController } from './conversation-settings/conversation-settings.controller';
import { ConversationSettingsService } from './conversation-settings/conversation-settings.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { DiscoveryController } from './discovery/discovery.controller';
import { DiscoveryService } from './discovery/discovery.service';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { MediaController } from './media/media.controller';
import { MediaService } from './media/media.service';
import { ProfileAvatarController } from './media/profile-avatar.controller';
import { ReceiptsController } from './receipts/receipts.controller';
import { ReceiptsService } from './receipts/receipts.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

const CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const REFRESH_TOKEN =
  '550e8400-e29b-41d4-a716-446655440000.3fQ8xZ7uV2nK5mP9rT4wY6aB1cD0eF8gH2jL7sN5qRk';
const PARTICIPANT_ID = '7d444840-9dc0-11d1-b245-5ffdce74fad2';
const GROUP_PARTICIPANT_ID = '7d444840-9dc0-41d1-b245-5ffdce74fad2';
const SECOND_PARTICIPANT_ID = '8e555951-aed1-42e2-8346-6aadece85be3';
const CLIENT_MESSAGE_ID = '7d444840-9dc0-41d1-b245-5ffdce74fad2';
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444';
const MEDIA_ID = '550e8400-e29b-41d4-a716-446655440000';

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
        BlocksController,
        DiscoveryController,
        ConversationsController,
        ConversationSettingsController,
        MessagesController,
        MediaController,
        ProfileAvatarController,
        ReceiptsController,
      ],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: UsersService, useValue: {} },
        { provide: BlocksService, useValue: {} },
        { provide: DiscoveryService, useValue: {} },
        { provide: ConversationsService, useValue: {} },
        { provide: ConversationSettingsService, useValue: {} },
        { provide: MessagesService, useValue: {} },
        { provide: MediaService, useValue: {} },
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
      },
    },
    {
      method: 'post',
      path: '/v1/media/uploads',
      schemaName: 'CreateMediaUploadDto',
      payload: {
        clientUploadId: '7d444840-9dc0-41d1-b245-5ffdce74fad2',
        purpose: 'profile_avatar',
        contentType: 'image/jpeg',
        sizeBytes: 245000,
        originalFilename: 'profile-photo.jpg',
      },
    },
    {
      method: 'put',
      path: '/v1/me/avatar',
      schemaName: 'SetProfileAvatarDto',
      payload: { mediaId: MEDIA_ID },
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
      path: '/v1/conversations/group',
      schemaName: 'CreateGroupConversationDto',
      payload: {
        name: 'Study Group',
        participantIds: [GROUP_PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
      },
    },
    {
      method: 'patch',
      path: '/v1/conversations/{conversationId}',
      schemaName: 'UpdateGroupConversationDto',
      payload: { name: 'Project Team', avatarUrl: null },
    },
    {
      method: 'post',
      path: '/v1/conversations/{conversationId}/members',
      schemaName: 'AddGroupMembersDto',
      payload: {
        participantIds: [GROUP_PARTICIPANT_ID, SECOND_PARTICIPANT_ID],
      },
    },
    {
      method: 'patch',
      path: '/v1/conversations/{conversationId}/members/{memberId}/role',
      schemaName: 'UpdateGroupMemberRoleDto',
      payload: { role: 'admin' },
    },
    {
      method: 'post',
      path: '/v1/conversations/{conversationId}/transfer-ownership',
      schemaName: 'TransferGroupOwnershipDto',
      payload: { newOwnerId: PARTICIPANT_ID },
    },
    {
      method: 'patch',
      path: '/v1/conversations/{conversationId}/settings',
      schemaName: 'UpdateConversationSettingsDto',
      payload: { archived: true, muted: false, pinned: true },
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
      const schemaRef = { $ref: `#/components/schemas/${schemaName}` };
      if (method === 'patch' && path === '/v1/conversations/{conversationId}') {
        expect(media?.schema).toEqual({
          minProperties: 1,
          allOf: [schemaRef],
        });
      } else {
        expect(media?.schema).toEqual(schemaRef);
      }

      const example = media?.examples?.default;
      expect(example).toBeDefined();
      if (!example || '$ref' in example) {
        throw new Error(`Missing inline request example for ${method} ${path}`);
      }

      expect(example.value).toEqual(payload);
    },
  );

  it('does not accept client-supplied avatar URLs in profile updates', () => {
    const schema = document.components?.schemas?.UpdateProfileDto;
    expect(schema).toBeDefined();
    if (!schema || '$ref' in schema) {
      throw new Error('UpdateProfileDto must be an inline component schema.');
    }
    expect(schema.properties).not.toHaveProperty('avatarUrl');
  });

  it('documents signed image/audio uploads and the profile-avatar lifecycle', () => {
    const createUpload = document.paths['/v1/media/uploads']?.post;
    expect(createUpload).toEqual(
      expect.objectContaining({
        security: [{ bearer: [] }],
        responses: expect.objectContaining({
          '201': expect.any(Object),
          '400': expect.any(Object),
          '409': expect.any(Object),
          '410': expect.any(Object),
          '413': expect.any(Object),
          '502': expect.any(Object),
          '503': expect.any(Object),
        }),
      }),
    );

    expect(document.components?.schemas?.CreateMediaUploadDto).toMatchObject({
      required: ['clientUploadId', 'purpose', 'contentType', 'sizeBytes'],
      properties: {
        clientUploadId: { type: 'string', format: 'uuid' },
        purpose: {
          type: 'string',
          enum: ['profile_avatar', 'message_attachment'],
        },
        contentType: {
          type: 'string',
          enum: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'audio/aac',
            'audio/mp4',
            'audio/m4a',
            'audio/x-m4a',
            'audio/mpeg',
            'audio/ogg',
            'audio/wav',
            'audio/x-wav',
          ],
        },
        sizeBytes: { type: 'number', minimum: 1, maximum: 20971520 },
        contentSha256: {
          type: 'string',
          pattern: '^[0-9a-f]{64}$',
        },
      },
    });

    expect(document.components?.schemas?.MediaAssetResponseDto).toMatchObject({
      required: expect.arrayContaining([
        'id',
        'purpose',
        'status',
        'type',
        'contentType',
        'sizeBytes',
      ]),
      properties: {
        type: { type: 'string', enum: ['image', 'audio'] },
        durationMs: { type: 'number', nullable: true, minimum: 1 },
      },
    });
    expect(
      document.components?.schemas?.CloudinaryUploadFieldsDto,
    ).toMatchObject({
      properties: {
        allowed_formats: {
          type: 'string',
          enum: ['jpg,jpeg,png,webp', 'aac,m4a,mp3,ogg,wav'],
        },
        transformation: expect.objectContaining({ type: 'string' }),
      },
    });

    const completeUpload =
      document.paths['/v1/media/uploads/{mediaId}/complete']?.post;
    const mediaParameter = completeUpload?.parameters?.find(
      (candidate) => !('$ref' in candidate) && candidate.name === 'mediaId',
    );
    expect(completeUpload).toEqual(
      expect.objectContaining({
        security: [{ bearer: [] }],
        responses: expect.objectContaining({
          '200': expect.any(Object),
          '400': expect.any(Object),
          '404': expect.any(Object),
          '409': expect.any(Object),
          '410': expect.any(Object),
          '502': expect.any(Object),
          '503': expect.any(Object),
        }),
      }),
    );
    expect(mediaParameter).toMatchObject({
      in: 'path',
      name: 'mediaId',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    });

    expect(document.paths['/v1/me/avatar']).toMatchObject({
      put: {
        security: [{ bearer: [] }],
        responses: {
          '200': expect.any(Object),
          '400': expect.any(Object),
          '404': expect.any(Object),
          '409': expect.any(Object),
        },
      },
      delete: {
        security: [{ bearer: [] }],
        responses: { '204': expect.any(Object) },
      },
    });
  });

  it('documents text, image, and audio messages with persisted attachment metadata', () => {
    const send =
      document.paths['/v1/conversations/{conversationId}/messages']?.post;
    expect(send).toEqual(
      expect.objectContaining({
        security: [{ bearer: [] }],
        responses: expect.objectContaining({
          '200': expect.any(Object),
          '404': expect.any(Object),
          '409': expect.any(Object),
        }),
      }),
    );

    expect(send?.requestBody).toMatchObject({
      content: {
        'application/json': {
          examples: {
            default: {
              value: {
                clientMessageId: CLIENT_MESSAGE_ID,
                text: 'Hello! Are you free to chat?',
              },
            },
            image: {
              value: {
                clientMessageId: CLIENT_MESSAGE_ID,
                text: 'Class photo',
                attachmentMediaIds: [MEDIA_ID],
              },
            },
            audio: {
              value: {
                clientMessageId: CLIENT_MESSAGE_ID,
                attachmentMediaIds: [MEDIA_ID],
              },
            },
          },
        },
      },
    });

    expect(document.components?.schemas?.SendMessageDto).toMatchObject({
      required: ['clientMessageId'],
      properties: {
        clientMessageId: { type: 'string', format: 'uuid' },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
        attachmentMediaIds: {
          type: 'array',
          items: { type: 'string', format: 'uuid' },
          minItems: 1,
          maxItems: 10,
          uniqueItems: true,
        },
      },
    });

    expect(document.components?.schemas?.MessageResponseDto).toMatchObject({
      required: expect.arrayContaining([
        'id',
        'conversationId',
        'clientMessageId',
        'senderId',
        'kind',
        'text',
        'attachments',
        'createdAt',
      ]),
      properties: {
        kind: { type: 'string', enum: ['text', 'image', 'audio'] },
        text: { type: 'string', nullable: true },
        attachments: {
          type: 'array',
          items: {
            oneOf: [
              {
                $ref: '#/components/schemas/MessageAttachmentResponseDto',
              },
              {
                $ref: '#/components/schemas/AudioMessageAttachmentResponseDto',
              },
            ],
            discriminator: {
              propertyName: 'type',
              mapping: {
                image: '#/components/schemas/MessageAttachmentResponseDto',
                audio: '#/components/schemas/AudioMessageAttachmentResponseDto',
              },
            },
          },
        },
      },
    });
    expect(
      document.components?.schemas?.MessageAttachmentResponseDto,
    ).toMatchObject({
      required: [
        'mediaId',
        'type',
        'contentType',
        'sizeBytes',
        'width',
        'height',
        'url',
      ],
      properties: {
        mediaId: { type: 'string', format: 'uuid' },
        type: { type: 'string', enum: ['image'] },
        sizeBytes: { type: 'number', minimum: 1 },
        width: { type: 'number', minimum: 1 },
        height: { type: 'number', minimum: 1 },
        url: { type: 'string', format: 'uri' },
      },
    });
    expect(
      document.components?.schemas?.AudioMessageAttachmentResponseDto,
    ).toMatchObject({
      required: [
        'mediaId',
        'type',
        'contentType',
        'sizeBytes',
        'durationMs',
        'url',
      ],
      properties: {
        mediaId: { type: 'string', format: 'uuid' },
        type: { type: 'string', enum: ['audio'] },
        sizeBytes: { type: 'number', minimum: 1, maximum: 20971520 },
        durationMs: { type: 'number', minimum: 1, maximum: 900000 },
        url: { type: 'string', format: 'uri' },
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

  it.each([
    'PublicDiscoveryUserDto',
    'ConversationParticipantDto',
    'GroupConversationParticipantDto',
    'BlockedPublicUserDto',
  ])(
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

  it('models direct and group conversations as distinct required schemas', () => {
    const commonRequired = [
      'id',
      'type',
      'latestMessage',
      'unreadCount',
      'settings',
      'lastActivityAt',
      'createdAt',
      'updatedAt',
    ];

    expect(
      document.components?.schemas?.DirectConversationResponseDto,
    ).toMatchObject({
      required: expect.arrayContaining([...commonRequired, 'otherParticipant']),
      properties: {
        type: { type: 'string', enum: ['direct'] },
        otherParticipant: {
          $ref: '#/components/schemas/ConversationParticipantDto',
        },
      },
    });
    expect(
      document.components?.schemas?.GroupConversationResponseDto,
    ).toMatchObject({
      required: expect.arrayContaining([
        ...commonRequired,
        'name',
        'avatarUrl',
        'participants',
        'role',
      ]),
      properties: {
        type: { type: 'string', enum: ['group'] },
        name: expect.any(Object) as object,
        participants: expect.any(Object) as object,
        role: expect.any(Object) as object,
      },
    });
  });

  it('uses a type discriminator for mixed conversation responses', () => {
    const expectedUnion = {
      oneOf: [
        { $ref: '#/components/schemas/DirectConversationResponseDto' },
        { $ref: '#/components/schemas/GroupConversationResponseDto' },
      ],
      discriminator: {
        propertyName: 'type',
        mapping: {
          direct: '#/components/schemas/DirectConversationResponseDto',
          group: '#/components/schemas/GroupConversationResponseDto',
        },
      },
    };
    const detailResponse =
      document.paths['/v1/conversations/{conversationId}']?.get?.responses?.[
        '200'
      ];
    if (!detailResponse || '$ref' in detailResponse) {
      throw new Error('Missing inline conversation detail response.');
    }
    expect(detailResponse.content?.['application/json']?.schema).toEqual(
      expectedUnion,
    );

    expect(
      document.components?.schemas?.ConversationListResponseDto,
    ).toMatchObject({
      properties: {
        items: {
          type: 'array',
          items: expectedUnion,
        },
      },
    });
  });

  it.each([
    ['/v1/contacts/match', 'post'],
    ['/v1/users/search', 'get'],
    ['/v1/me/blocks', 'get'],
    ['/v1/me/blocks/{userId}', 'put'],
    ['/v1/me/blocks/{userId}', 'delete'],
    ['/v1/conversations/direct', 'post'],
    ['/v1/conversations/group', 'post'],
    ['/v1/conversations', 'get'],
    ['/v1/conversations/{conversationId}', 'get'],
    ['/v1/conversations/{conversationId}', 'patch'],
    ['/v1/conversations/{conversationId}', 'delete'],
    ['/v1/conversations/{conversationId}/members', 'post'],
    ['/v1/conversations/{conversationId}/members/{memberId}', 'delete'],
    ['/v1/conversations/{conversationId}/members/{memberId}/role', 'patch'],
    ['/v1/conversations/{conversationId}/transfer-ownership', 'post'],
    ['/v1/conversations/{conversationId}/leave', 'post'],
    ['/v1/conversations/{conversationId}/settings', 'patch'],
    ['/v1/conversations/{conversationId}/messages', 'post'],
    ['/v1/conversations/{conversationId}/messages', 'get'],
    ['/v1/conversations/{conversationId}/read', 'post'],
    ['/v1/conversations/{conversationId}/receipts/delivered', 'put'],
    ['/v1/conversations/{conversationId}/receipts/read', 'put'],
    ['/v1/conversations/{conversationId}/receipts', 'get'],
  ] as const)('%s requires bearer authentication', (path, method) => {
    expect(document.paths[path]?.[method]?.security).toEqual([{ bearer: [] }]);
  });

  it.each([
    [
      '/v1/users/search',
      { type: 'integer', minimum: 1, maximum: 25, default: 20 },
    ],
    [
      '/v1/conversations',
      {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        default: 20,
        example: 20,
      },
    ],
    [
      '/v1/conversations/{conversationId}/messages',
      { type: 'integer', minimum: 1, maximum: 100, default: 50 },
    ],
  ] as const)(
    '%s documents limit as an integer query parameter',
    (path, expectedSchema) => {
      const parameter = document.paths[path]?.get?.parameters?.find(
        (candidate) =>
          !('$ref' in candidate) &&
          candidate.in === 'query' &&
          candidate.name === 'limit',
      );

      if (!parameter || '$ref' in parameter) {
        throw new Error(`Missing inline limit parameter for GET ${path}`);
      }

      expect(parameter).toMatchObject({
        in: 'query',
        name: 'limit',
        required: false,
      });
      expect(parameter.schema).toEqual(expectedSchema);
    },
  );

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

  it('documents the archived conversation filter as a boolean', () => {
    const parameter = document.paths[
      '/v1/conversations'
    ]?.get?.parameters?.find(
      (candidate) =>
        !('$ref' in candidate) &&
        candidate.in === 'query' &&
        candidate.name === 'archived',
    );
    expect(parameter).toMatchObject({
      in: 'query',
      name: 'archived',
      required: false,
      schema: { type: 'boolean', default: false },
    });
  });

  it('documents group lifecycle success responses and schemas', () => {
    for (const [path, method] of [
      ['/v1/conversations/{conversationId}', 'patch'],
      ['/v1/conversations/{conversationId}/members', 'post'],
      ['/v1/conversations/{conversationId}/members/{memberId}/role', 'patch'],
      ['/v1/conversations/{conversationId}/transfer-ownership', 'post'],
    ] as const) {
      const response = document.paths[path]?.[method]?.responses?.['200'];
      if (!response || '$ref' in response) {
        throw new Error(
          `Missing inline success response for ${method} ${path}`,
        );
      }
      expect(response.content?.['application/json']?.schema).toEqual({
        $ref: '#/components/schemas/GroupConversationResponseDto',
      });
    }

    for (const [path, method] of [
      ['/v1/conversations/{conversationId}/members/{memberId}', 'delete'],
      ['/v1/conversations/{conversationId}/leave', 'post'],
      ['/v1/conversations/{conversationId}', 'delete'],
    ] as const) {
      expect(document.paths[path]?.[method]?.responses?.['204']).toBeDefined();
    }
  });

  it.each([
    [
      '/v1/conversations/{conversationId}',
      'patch',
      ['200', '400', '403', '404'],
    ],
    [
      '/v1/conversations/{conversationId}/members',
      'post',
      ['200', '400', '403', '404', '409'],
    ],
    [
      '/v1/conversations/{conversationId}/members/{memberId}',
      'delete',
      ['204', '400', '403', '404', '409'],
    ],
    [
      '/v1/conversations/{conversationId}/members/{memberId}/role',
      'patch',
      ['200', '400', '403', '404', '409'],
    ],
    [
      '/v1/conversations/{conversationId}/transfer-ownership',
      'post',
      ['200', '400', '403', '404'],
    ],
    ['/v1/conversations/{conversationId}/leave', 'post', ['204', '404', '409']],
    ['/v1/conversations/{conversationId}', 'delete', ['204', '403', '404']],
  ] as const)(
    '%s documents its group lifecycle status outcomes',
    (path, method, expectedStatuses) => {
      expect(
        Object.keys(document.paths[path]?.[method]?.responses ?? {}),
      ).toEqual(expect.arrayContaining([...expectedStatuses]));
    },
  );

  it('documents nullable group avatar removal and assignable member roles', () => {
    expect(
      document.components?.schemas?.UpdateGroupConversationDto,
    ).toMatchObject({
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 100 },
        avatarUrl: { type: 'string', nullable: true, format: 'uri' },
      },
    });
    expect(
      document.components?.schemas?.UpdateGroupMemberRoleDto,
    ).toMatchObject({
      required: ['role'],
      properties: {
        role: { type: 'string', enum: ['admin', 'member'] },
      },
    });
  });

  it.each([
    ['/v1/conversations/{conversationId}', 'patch', ['conversationId']],
    ['/v1/conversations/{conversationId}/members', 'post', ['conversationId']],
    [
      '/v1/conversations/{conversationId}/members/{memberId}',
      'delete',
      ['conversationId', 'memberId'],
    ],
    [
      '/v1/conversations/{conversationId}/members/{memberId}/role',
      'patch',
      ['conversationId', 'memberId'],
    ],
    [
      '/v1/conversations/{conversationId}/transfer-ownership',
      'post',
      ['conversationId'],
    ],
    ['/v1/conversations/{conversationId}/leave', 'post', ['conversationId']],
    ['/v1/conversations/{conversationId}', 'delete', ['conversationId']],
  ] as const)(
    '%s documents UUID path parameters',
    (path, method, expectedNames) => {
      const parameters = document.paths[path]?.[method]?.parameters ?? [];
      for (const name of expectedNames) {
        const parameter = parameters.find(
          (candidate) => !('$ref' in candidate) && candidate.name === name,
        );
        expect(parameter).toMatchObject({
          in: 'path',
          name,
          required: true,
          schema: { format: 'uuid', type: 'string' },
        });
      }
    },
  );

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

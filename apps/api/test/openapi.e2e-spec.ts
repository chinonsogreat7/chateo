import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { ConversationSettingsController } from '../src/conversation-settings/conversation-settings.controller';
import { ConversationSettingsService } from '../src/conversation-settings/conversation-settings.service';
import { ConversationsController } from '../src/conversations/conversations.controller';
import { ConversationsService } from '../src/conversations/conversations.service';
import { MessagesController } from '../src/messages/messages.controller';
import { MessagesService } from '../src/messages/messages.service';

describe('Conversation settings and clear-chat OpenAPI contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [
        ConversationSettingsController,
        ConversationsController,
        MessagesController,
      ],
      providers: [
        { provide: ConversationSettingsService, useValue: {} },
        { provide: ConversationsService, useValue: {} },
        { provide: MessagesService, useValue: {} },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('v1');
    document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('ChatMe API')
        .setVersion('1.0')
        .addBearerAuth()
        .build(),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents every duration accepted by the mute endpoint', () => {
    expect(document.paths['/v1/conversations/{conversationId}/mute']).toEqual(
      expect.objectContaining({
        put: expect.objectContaining({
          security: [{ bearer: [] }],
          responses: expect.objectContaining({
            '200': expect.any(Object),
            '400': expect.any(Object),
            '404': expect.any(Object),
          }),
          requestBody: expect.objectContaining({
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/MuteConversationDto',
                },
              },
            },
          }),
        }),
        delete: expect.objectContaining({
          security: [{ bearer: [] }],
          responses: expect.objectContaining({
            '200': expect.any(Object),
            '404': expect.any(Object),
          }),
        }),
      }),
    );
    expect(document.components?.schemas?.MuteConversationDto).toMatchObject({
      required: ['duration'],
      properties: {
        duration: {
          type: 'string',
          enum: ['8_hours', '24_hours', '7_days', 'always'],
        },
      },
    });
  });

  it('documents the add-to-favorites and remove-from-favorites actions', () => {
    const path = document.paths['/v1/conversations/{conversationId}/favorite'];

    for (const operation of [path?.put, path?.delete]) {
      expect(operation).toEqual(
        expect.objectContaining({
          security: [{ bearer: [] }],
          responses: expect.objectContaining({
            '200': expect.any(Object),
            '404': expect.any(Object),
          }),
        }),
      );
    }
  });

  it('documents dedicated archive, unarchive, and archived-list actions', () => {
    const archivePath =
      document.paths['/v1/conversations/{conversationId}/archive'];

    for (const operation of [archivePath?.put, archivePath?.delete]) {
      expect(operation).toEqual(
        expect.objectContaining({
          security: [{ bearer: [] }],
          responses: expect.objectContaining({
            '200': expect.objectContaining({
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/ConversationSettingsResponseDto',
                  },
                },
              },
            }),
            '400': expect.any(Object),
            '404': expect.any(Object),
          }),
        }),
      );
    }

    const archivedList = document.paths['/v1/conversations/archived']?.get;
    expect(archivedList).toEqual(
      expect.objectContaining({
        security: [{ bearer: [] }],
        parameters: expect.arrayContaining([
          expect.objectContaining({
            name: 'limit',
            in: 'query',
            schema: expect.objectContaining({
              type: 'integer',
              minimum: 1,
              maximum: 50,
              default: 20,
            }),
          }),
          expect.objectContaining({
            name: 'cursor',
            in: 'query',
            schema: expect.objectContaining({ type: 'string' }),
          }),
        ]),
        responses: expect.objectContaining({
          '200': expect.objectContaining({
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/ConversationListResponseDto',
                },
              },
            },
          }),
          '400': expect.any(Object),
        }),
      }),
    );
  });

  it('keeps the legacy settings patch and archived list filter documented', () => {
    expect(
      document.paths['/v1/conversations/{conversationId}/settings']?.patch,
    ).toEqual(expect.objectContaining({ security: [{ bearer: [] }] }));

    expect(document.paths['/v1/conversations']?.get?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'archived',
          in: 'query',
          schema: expect.objectContaining({ type: 'boolean' }),
        }),
      ]),
    );
  });

  it('documents all member-specific settings in action responses', () => {
    expect(
      document.components?.schemas?.ConversationSettingsResponseDto,
    ).toMatchObject({
      required: expect.arrayContaining([
        'conversationId',
        'archived',
        'muted',
        'pinned',
        'favorited',
        'archivedAt',
        'mutedAt',
        'mutedUntil',
        'pinnedAt',
        'favoritedAt',
        'clearedAt',
        'clearedThroughMessageId',
      ]),
      properties: {
        mutedUntil: { type: 'string', format: 'date-time', nullable: true },
        favorited: { type: 'boolean' },
        favoritedAt: { type: 'string', format: 'date-time', nullable: true },
        clearedAt: { type: 'string', format: 'date-time', nullable: true },
        clearedThroughMessageId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },
      },
    });
  });

  it('documents clear chat as a member-specific 200 response with its boundary', () => {
    const operation =
      document.paths['/v1/conversations/{conversationId}/messages']?.delete;
    expect(operation?.security).toEqual([{ bearer: [] }]);
    expect(operation?.responses).toEqual(
      expect.objectContaining({
        '200': expect.objectContaining({
          content: {
            'application/json': {
              schema: {
                $ref: '#/components/schemas/ClearConversationMessagesResponseDto',
              },
            },
          },
        }),
        '404': expect.any(Object),
      }),
    );
    expect(
      document.components?.schemas?.ClearConversationMessagesResponseDto,
    ).toMatchObject({
      required: [
        'conversationId',
        'changed',
        'clearedAt',
        'clearedThroughMessageId',
      ],
      properties: {
        conversationId: { type: 'string', format: 'uuid' },
        changed: { type: 'boolean' },
        clearedAt: { type: 'string', format: 'date-time', nullable: true },
        clearedThroughMessageId: {
          type: 'string',
          format: 'uuid',
          nullable: true,
        },
      },
    });
  });
});

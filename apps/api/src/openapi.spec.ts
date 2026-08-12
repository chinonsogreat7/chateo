import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  DocumentBuilder,
  type OpenAPIObject,
  SwaggerModule,
} from '@nestjs/swagger';
import { AuthController } from './auth/auth.controller';
import { AuthService } from './auth/auth.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';

const CHALLENGE_ID = '550e8400-e29b-41d4-a716-446655440000';
const REFRESH_TOKEN =
  '550e8400-e29b-41d4-a716-446655440000.3fQ8xZ7uV2nK5mP9rT4wY6aB1cD0eF8gH2jL7sN5qRk';

interface RequestExampleCase {
  method: 'patch' | 'post';
  path: string;
  payload: Record<string, unknown>;
  schemaName: string;
}

describe('OpenAPI request examples', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, UsersController],
      providers: [
        { provide: AuthService, useValue: {} },
        { provide: UsersService, useValue: {} },
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
});

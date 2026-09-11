import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import type { PushDevice } from '@prisma/client';
import request from 'supertest';
import { AuthRepository } from '../src/auth/auth.repository';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard';
import { Clock } from '../src/auth/providers/clock';
import { ApiExceptionFilter } from '../src/common/filters/api-exception.filter';
import { NoStoreInterceptor } from '../src/common/no-store.interceptor';
import { PrismaService } from '../src/database/prisma.service';
import { PushController } from '../src/push/push.controller';
import { PushRepository } from '../src/push/push.repository';

const USER = '00000000-0000-4000-8000-000000002101';
const OTHER = '00000000-0000-4000-8000-000000002102';
const SESSION = '00000000-0000-4000-8000-000000002201';
const OTHER_SESSION = '00000000-0000-4000-8000-000000002202';
const INSTALLATION = '00000000-0000-4000-8000-000000002301';
const SECOND_INSTALLATION = '00000000-0000-4000-8000-000000002302';
const NOW = new Date('2026-09-11T12:00:00Z');
const BODY = { platform: 'ios', token: 'ExpoPushToken[e2e_token_1234567890]' };
type DeviceUpdate = Omit<Partial<PushDevice>, 'version'> & {
  version?: number | { increment: number };
};

describe('Push device API (real validation/authentication/repository, in-memory database)', () => {
  let app: INestApplication;
  let token: string;
  let otherToken: string;
  let revoked: Set<string>;
  let devices: Map<string, PushDevice>;
  let config: ConfigService;
  const base = `/v1/me/push-devices/${INSTALLATION}`;

  beforeEach(async () => {
    revoked = new Set();
    devices = new Map();
    const update = (id: string, data: DeviceUpdate) => {
      const row = devices.get(id)!;
      const version =
        typeof data.version === 'object'
          ? row.version + data.version.increment
          : (data.version ?? row.version);
      const value = { ...row, ...data, version };
      devices.set(id, value);
      return value;
    };
    const sessionFor = (id?: string, userId?: string) => {
      if (!id || revoked.has(id)) return null;
      if (
        (id === SESSION && userId === USER) ||
        (id === OTHER_SESSION && userId === OTHER)
      )
        return { familyId: id };
      return null;
    };
    const tx = {
      authSession: {
        findFirst: jest.fn(
          async ({ where }: { where: { id: string; userId: string } }) =>
            sessionFor(where.id, where.userId),
        ),
      },
      pushDevice: {
        findUnique: jest.fn(
          async ({ where }: { where: { id?: string; tokenHash?: string } }) =>
            where.id
              ? (devices.get(where.id) ?? null)
              : ([...devices.values()].find(
                  (device) => device.tokenHash === where.tokenHash,
                ) ?? null),
        ),
        count: jest.fn(
          async ({
            where,
          }: {
            where: {
              userId: string;
              id: { not: string };
              tokenHash: { not: string };
            };
          }) =>
            [...devices.values()].filter(
              (device) =>
                device.userId === where.userId &&
                device.id !== where.id.not &&
                device.tokenHash !== where.tokenHash.not &&
                !device.disabledAt,
            ).length,
        ),
        upsert: jest.fn(
          async ({
            where,
            create,
            update: data,
          }: {
            where: { id: string };
            create: Omit<PushDevice, 'version'>;
            update: DeviceUpdate;
          }) => {
            if (devices.has(where.id)) return update(where.id, data);
            const device = { ...create, version: 0 };
            devices.set(where.id, device);
            return device;
          },
        ),
        update: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string };
            data: DeviceUpdate;
          }) => update(where.id, data),
        ),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: { id: string; userId: string; familyId: string };
            data: DeviceUpdate;
          }) => {
            const device = devices.get(where.id);
            if (
              !device ||
              device.userId !== where.userId ||
              device.familyId !== where.familyId ||
              device.disabledAt
            )
              return { count: 0 };
            update(device.id, data);
            return { count: 1 };
          },
        ),
      },
    };
    config = new ConfigService({ PUSH_NOTIFICATIONS_ENABLED: true });
    const module = await Test.createTestingModule({
      imports: [
        JwtModule.register({
          secret: 'push-e2e-secret-at-least-thirty-two-characters',
        }),
      ],
      controllers: [PushController],
      providers: [
        PushRepository,
        NoStoreInterceptor,
        {
          provide: PrismaService,
          useValue: {
            ...tx,
            $transaction: async (
              callback: (value: typeof tx) => Promise<unknown>,
            ) => callback(tx),
          },
        },
        {
          provide: AuthRepository,
          useValue: {
            isSessionActive: async (sid: string, sub: string) =>
              Boolean(sessionFor(sid, sub)),
          },
        },
        { provide: Clock, useValue: { now: () => NOW } },
        { provide: ConfigService, useValue: config },
        { provide: APP_GUARD, useClass: JwtAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('v1');
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.init();
    token = await module
      .get(JwtService)
      .signAsync({ sub: USER, sid: SESSION, profileComplete: true });
    otherToken = await module
      .get(JwtService)
      .signAsync({ sub: OTHER, sid: OTHER_SESSION, profileComplete: true });
  });
  afterEach(async () => {
    await app.close();
  });

  it('registers idempotently and rotates tokens without returning secrets', async () => {
    const first = await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(200)
      .expect('Cache-Control', 'no-store');
    expect(first.body).toEqual({
      installationId: INSTALLATION,
      platform: 'ios',
      registeredAt: NOW.toISOString(),
    });
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(200);
    expect(devices.get(INSTALLATION)?.version).toBe(0);
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send({ ...BODY, token: 'ExpoPushToken[rotated_1234567890]' })
      .expect(200);
    expect(devices.get(INSTALLATION)).toMatchObject({
      version: 1,
      familyId: SESSION,
    });
  });
  it('moves a possessed token on reinstall and permits account switching without duplicate recipients', async () => {
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(200);
    await request(app.getHttpServer())
      .put(`/v1/me/push-devices/${SECOND_INSTALLATION}`)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(200);
    expect(devices.get(INSTALLATION)).toMatchObject({
      token: null,
      disabledAt: NOW,
    });
    const newPath = `/v1/me/push-devices/${SECOND_INSTALLATION}`;
    await request(app.getHttpServer())
      .put(newPath)
      .set('Authorization', `Bearer ${otherToken}`)
      .send(BODY)
      .expect(200);
    expect(devices.get(SECOND_INSTALLATION)).toMatchObject({
      userId: OTHER,
      familyId: OTHER_SESSION,
      version: 1,
    });
    await request(app.getHttpServer())
      .delete(newPath)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(devices.get(SECOND_INSTALLATION)?.disabledAt).toBeNull();
  });
  it('prevents another user from overwriting a known installation with an unrelated token', async () => {
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(200);
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${otherToken}`)
      .send({ ...BODY, token: 'ExpoPushToken[unrelated_1234567890]' })
      .expect(404);
    expect(devices.get(INSTALLATION)?.userId).toBe(USER);
  });
  it('requires an active session and rejects malformed registration bodies', async () => {
    await request(app.getHttpServer()).put(base).send(BODY).expect(401);
    await request(app.getHttpServer()).delete(base).expect(401);
    for (const body of [
      { ...BODY, platform: 'web' },
      { ...BODY, token: 'native-fcm-token' },
      { ...BODY, userId: OTHER },
      { platform: 'ios' },
    ]) {
      await request(app.getHttpServer())
        .put(base)
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);
    }
    revoked.add(SESSION);
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(401);
    expect(devices.size).toBe(0);
  });
  it('unregisters idempotently even when delivery is disabled', async () => {
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(200);
    config.set('PUSH_NOTIFICATIONS_ENABLED', false);
    await request(app.getHttpServer())
      .put(base)
      .set('Authorization', `Bearer ${token}`)
      .send(BODY)
      .expect(503);
    await request(app.getHttpServer())
      .delete(base)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await request(app.getHttpServer())
      .delete(base)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(devices.get(INSTALLATION)).toMatchObject({
      token: null,
      tokenHash: null,
      disabledAt: NOW,
      version: 1,
    });
  });
});

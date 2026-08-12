import { type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { io } from 'socket.io-client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { RealtimeIoAdapter } from '../src/realtime/realtime-io.adapter';

interface SocketErrorWithData extends Error {
  data?: unknown;
}

describe('AppModule wiring (e2e smoke)', () => {
  let app: INestApplication;
  let serverUrl: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .compile();

    app = moduleFixture.createNestApplication();
    app.useLogger(false);
    app.setGlobalPrefix('v1');
    app.useWebSocketAdapter(
      new RealtimeIoAdapter(app, moduleFixture.get(ConfigService)),
    );
    await app.listen(0, '127.0.0.1');
    serverUrl = await app.getUrl();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('boots the real module graph and exposes health and feature routes', async () => {
    await request(app.getHttpServer())
      .get('/v1/health')
      .expect(200)
      .expect({ status: 'ok', service: 'chateo-api' });

    await request(app.getHttpServer())
      .get('/v1/users/search?q=ada')
      .expect(401);
    await request(app.getHttpServer()).get('/v1/conversations').expect(401);
    await request(app.getHttpServer())
      .get('/v1/conversations/550e8400-e29b-41d4-a716-446655440000/messages')
      .expect(401);
    await request(app.getHttpServer())
      .get('/v1/conversations/550e8400-e29b-41d4-a716-446655440000/receipts')
      .expect(401);
  });

  it('boots the production realtime module and adapter with stable socket authentication', async () => {
    const socket = io(`${serverUrl}/chat`, {
      autoConnect: false,
      forceNew: true,
      reconnection: false,
      transports: ['websocket'],
      auth: { token: 'invalid-access-token' },
    });

    const error = await new Promise<SocketErrorWithData>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Socket authentication timed out.')),
        2_000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        reject(new Error('Invalid socket unexpectedly connected.'));
      });
      socket.once('connect_error', (reason: SocketErrorWithData) => {
        clearTimeout(timer);
        resolve(reason);
      });
      socket.connect();
    });
    socket.disconnect();

    expect(error.data).toEqual({
      code: 'AUTH_ACCESS_TOKEN_INVALID',
      message: 'A valid access token is required.',
    });
  });
});

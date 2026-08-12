import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';

describe('AppModule wiring (e2e smoke)', () => {
  let app: INestApplication;

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
    await app.init();
  });

  afterAll(async () => {
    await app.close();
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
  });
});

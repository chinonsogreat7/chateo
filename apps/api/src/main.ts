import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/filters/api-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  const config = app.get(ConfigService);
  const environment = config.get<string>('NODE_ENV', 'development');
  const trustProxy = config.get<string>('TRUST_PROXY', 'loopback');
  const corsOrigins = config
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.set('trust proxy', trustProxy || false);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.enableCors({
    origin: environment === 'production' ? corsOrigins : true,
    credentials: false,
  });
  app.setGlobalPrefix('v1');
  app.useGlobalPipes(
    new ValidationPipe({
      forbidNonWhitelisted: true,
      transform: true,
      whitelist: true,
    }),
  );
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  if (environment !== 'production') {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('ChatMe API')
      .setDescription('Phone authentication and chat backend API')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const documentFactory = () =>
      SwaggerModule.createDocument(app, swaggerConfig, {
        operationIdFactory: (_controllerKey, methodKey) => methodKey,
      });
    SwaggerModule.setup('docs', app, documentFactory, {
      useGlobalPrefix: true,
      jsonDocumentUrl: 'docs/openapi.json',
    });
  }

  const port = config.get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`ChatMe API listening on port ${port}`, 'Bootstrap');
}

bootstrap().catch((error: unknown) => {
  const logger = new Logger('Bootstrap');
  logger.error(
    error instanceof Error ? error.message : 'Failed to start the API',
    error instanceof Error ? error.stack : undefined,
  );
  process.exitCode = 1;
});

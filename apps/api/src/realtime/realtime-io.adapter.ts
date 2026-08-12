import type { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import { Server, type ServerOptions } from 'socket.io';

type AllowRequestCallback = (
  error: string | null | undefined,
  success: boolean,
) => void;

export class RealtimeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: ConfigService,
  ) {
    super(app);
  }

  override createIOServer(
    port: number,
    options?: Partial<ServerOptions>,
  ): Server {
    return super.createIOServer(port, {
      ...options,
      cors: {
        origin: configuredRealtimeCorsOrigin(this.config),
        credentials: false,
      },
      allowRequest: configuredRealtimeAllowRequest(this.config),
    });
  }
}

export function configuredRealtimeAllowRequest(
  config: ConfigService,
): (request: IncomingMessage, callback: AllowRequestCallback) => void {
  const allowedOrigins = configuredRealtimeCorsOrigin(config);
  return (request, callback): void => {
    const origin = request.headers.origin;
    const allowed =
      origin === undefined ||
      allowedOrigins === true ||
      (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin));
    callback(null, allowed);
  };
}

export function configuredRealtimeCorsOrigin(
  config: ConfigService,
): true | string[] | false {
  if (config.get<string>('NODE_ENV', 'development') !== 'production') {
    return true;
  }

  const corsOrigins = config
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  return corsOrigins.length > 0 ? corsOrigins : false;
}

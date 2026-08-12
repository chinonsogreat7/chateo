import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import type { AuthenticatedUser } from '../common/types/authenticated-request';
import {
  REALTIME_AUTH_ERROR_CODE,
  REALTIME_AUTH_ERROR_MESSAGE,
  type RealtimeSocketData,
} from './realtime.types';

interface RealtimeAccessTokenPayload extends AuthenticatedUser {
  exp: number;
}

export class RealtimeAuthenticationError extends Error {
  readonly data = {
    code: REALTIME_AUTH_ERROR_CODE,
    message: REALTIME_AUTH_ERROR_MESSAGE,
  } as const;

  constructor() {
    super(REALTIME_AUTH_ERROR_MESSAGE);
    this.name = 'RealtimeAuthenticationError';
  }
}

@Injectable()
export class RealtimeAuthenticator {
  constructor(
    private readonly jwtService: JwtService,
    private readonly repository: AuthRepository,
    private readonly clock: Clock,
  ) {}

  async authenticate(socket: Socket): Promise<RealtimeSocketData> {
    const token = extractRealtimeAccessToken(socket);
    if (!token) throw new RealtimeAuthenticationError();

    let payload: RealtimeAccessTokenPayload;
    try {
      payload = await this.jwtService.verifyAsync<RealtimeAccessTokenPayload>(
        token,
        {
          audience: 'chateo-mobile',
          issuer: 'chateo-api',
        },
      );
    } catch {
      throw new RealtimeAuthenticationError();
    }

    const now = this.clock.now();
    if (!isValidAccessTokenPayload(payload, now)) {
      throw new RealtimeAuthenticationError();
    }

    const active = await this.repository.isSessionActive(
      payload.sid,
      payload.sub,
      now,
    );
    if (!active) throw new RealtimeAuthenticationError();

    return {
      userId: payload.sub,
      sessionId: payload.sid,
      tokenExpiresAt: payload.exp * 1000,
    };
  }
}

export function extractRealtimeAccessToken(socket: Socket): string | null {
  const authentication = socket.handshake.auth as Record<string, unknown>;
  const authToken = authentication.token;
  if (typeof authToken === 'string' && authToken.trim().length > 0) {
    return authToken.trim();
  }

  const authorization = socket.handshake.headers.authorization;
  if (typeof authorization !== 'string') return null;

  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  return match?.[1] ?? null;
}

function isValidAccessTokenPayload(
  payload: RealtimeAccessTokenPayload,
  now: Date,
): boolean {
  return (
    typeof payload.sub === 'string' &&
    payload.sub.length > 0 &&
    typeof payload.sid === 'string' &&
    payload.sid.length > 0 &&
    typeof payload.profileComplete === 'boolean' &&
    typeof payload.exp === 'number' &&
    Number.isSafeInteger(payload.exp) &&
    payload.exp * 1000 > now.getTime()
  );
}

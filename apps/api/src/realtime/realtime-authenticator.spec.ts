import { JwtService } from '@nestjs/jwt';
import type { Socket } from 'socket.io';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import {
  extractRealtimeAccessToken,
  RealtimeAuthenticationError,
  RealtimeAuthenticator,
} from './realtime-authenticator';
import {
  REALTIME_AUTH_ERROR_CODE,
  REALTIME_AUTH_ERROR_MESSAGE,
} from './realtime.types';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

function testSocket(input: {
  authToken?: unknown;
  authorization?: string;
}): Socket {
  return {
    handshake: {
      auth: input.authToken === undefined ? {} : { token: input.authToken },
      headers:
        input.authorization === undefined
          ? {}
          : { authorization: input.authorization },
    },
  } as unknown as Socket;
}

function createAuthenticator() {
  const verifyAsync = jest.fn();
  const isSessionActive = jest.fn();
  const authenticator = new RealtimeAuthenticator(
    { verifyAsync } as unknown as JwtService,
    { isSessionActive } as unknown as AuthRepository,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
  );
  return { authenticator, isSessionActive, verifyAsync };
}

async function expectStableAuthError(promise: Promise<unknown>): Promise<void> {
  const error = await promise.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(RealtimeAuthenticationError);
  expect(error).toMatchObject({
    message: REALTIME_AUTH_ERROR_MESSAGE,
    data: {
      code: REALTIME_AUTH_ERROR_CODE,
      message: REALTIME_AUTH_ERROR_MESSAGE,
    },
  });
}

describe('RealtimeAuthenticator', () => {
  it('authenticates an auth.token, validates issuer/audience, and checks the session', async () => {
    const { authenticator, isSessionActive, verifyAsync } =
      createAuthenticator();
    const expiresAtSeconds = Math.floor(NOW.getTime() / 1000) + 900;
    verifyAsync.mockResolvedValue({
      sub: USER_ID,
      sid: SESSION_ID,
      profileComplete: true,
      exp: expiresAtSeconds,
    });
    isSessionActive.mockResolvedValue(true);

    await expect(
      authenticator.authenticate(testSocket({ authToken: 'access-token' })),
    ).resolves.toEqual({
      userId: USER_ID,
      sessionId: SESSION_ID,
      tokenExpiresAt: expiresAtSeconds * 1000,
    });

    expect(verifyAsync).toHaveBeenCalledWith('access-token', {
      audience: 'chateo-mobile',
      issuer: 'chateo-api',
    });
    expect(isSessionActive).toHaveBeenCalledWith(SESSION_ID, USER_ID, NOW);
  });

  it('supports a strict Authorization Bearer handshake header', async () => {
    const { authenticator, isSessionActive, verifyAsync } =
      createAuthenticator();
    verifyAsync.mockResolvedValue({
      sub: USER_ID,
      sid: SESSION_ID,
      profileComplete: false,
      exp: Math.floor(NOW.getTime() / 1000) + 60,
    });
    isSessionActive.mockResolvedValue(true);

    await authenticator.authenticate(
      testSocket({ authorization: 'Bearer header-token' }),
    );

    expect(verifyAsync).toHaveBeenCalledWith(
      'header-token',
      expect.any(Object),
    );
  });

  it('rejects a revoked session with the stable public error', async () => {
    const { authenticator, isSessionActive, verifyAsync } =
      createAuthenticator();
    verifyAsync.mockResolvedValue({
      sub: USER_ID,
      sid: SESSION_ID,
      profileComplete: true,
      exp: Math.floor(NOW.getTime() / 1000) + 60,
    });
    isSessionActive.mockResolvedValue(false);

    await expectStableAuthError(
      authenticator.authenticate(testSocket({ authToken: 'secret-token' })),
    );
  });

  it.each([
    {},
    { sub: USER_ID, sid: SESSION_ID, profileComplete: true },
    {
      sub: USER_ID,
      sid: SESSION_ID,
      profileComplete: true,
      exp: Math.floor(NOW.getTime() / 1000),
    },
  ])('rejects missing, malformed, or expired credentials', async (payload) => {
    const { authenticator, verifyAsync } = createAuthenticator();
    if (Object.keys(payload).length > 0) verifyAsync.mockResolvedValue(payload);

    const promise = authenticator.authenticate(
      testSocket(Object.keys(payload).length > 0 ? { authToken: 'token' } : {}),
    );
    await expectStableAuthError(promise);
  });
});

describe('extractRealtimeAccessToken', () => {
  it('prefers auth.token and never accepts query-string credentials', () => {
    const socket = testSocket({
      authToken: '  auth-token  ',
      authorization: 'Bearer header-token',
    });
    expect(extractRealtimeAccessToken(socket)).toBe('auth-token');

    const queryOnly = {
      handshake: { auth: {}, headers: {}, query: { token: 'query-token' } },
    } as unknown as Socket;
    expect(extractRealtimeAccessToken(queryOnly)).toBeNull();
  });
});

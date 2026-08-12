import { ConfigService } from '@nestjs/config';
import type { Namespace, Socket } from 'socket.io';
import { Clock } from '../auth/providers/clock';
import { ChatGateway, userRoom } from './chat.gateway';
import { ChatStateService } from './chat-state.service';
import {
  RealtimeAuthenticationError,
  RealtimeAuthenticator,
} from './realtime-authenticator';

const NOW = new Date('2026-08-12T12:00:00.000Z');

function createGateway(maximumConnectionsPerUser = 5) {
  const authenticate = jest.fn();
  const gateway = new ChatGateway(
    { authenticate } as unknown as RealtimeAuthenticator,
    { now: jest.fn().mockReturnValue(NOW) } as Clock,
    {
      register: jest.fn(),
      disconnect: jest.fn().mockResolvedValue(undefined),
    } as unknown as ChatStateService,
    new ConfigService({
      REALTIME_MAX_CONNECTIONS_PER_USER: maximumConnectionsPerUser,
    }),
  );
  return { authenticate, gateway };
}

describe('ChatGateway', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects failed handshakes with stable connect_error data', async () => {
    const { authenticate, gateway } = createGateway();
    authenticate.mockRejectedValue(new Error('verification failed'));
    let middleware:
      | ((socket: Socket, next: (error?: Error) => void) => void)
      | undefined;
    const namespace = {
      use: jest.fn().mockImplementation((candidate) => {
        middleware = candidate;
      }),
    } as unknown as Namespace;
    gateway.afterInit(namespace);

    const next = jest.fn();
    middleware?.({} as Socket, next);
    await Promise.resolve();
    await Promise.resolve();

    const error = next.mock.calls[0]?.[0] as RealtimeAuthenticationError;
    expect(error).toBeInstanceOf(RealtimeAuthenticationError);
    expect(error.data).toEqual({
      code: 'AUTH_ACCESS_TOKEN_INVALID',
      message: 'A valid access token is required.',
    });
    expect(JSON.stringify(error.data)).not.toContain('verification failed');
  });

  it('joins the authenticated user room and disconnects at token expiry', async () => {
    jest.useFakeTimers();
    const { gateway } = createGateway();
    let disconnectListener: (() => void) | undefined;
    const client = {
      data: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'session-one',
        tokenExpiresAt: NOW.getTime() + 1_000,
      },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      connected: true,
      once: jest.fn().mockImplementation((_event, listener) => {
        disconnectListener = listener;
      }),
    };

    await gateway.handleConnection(client as never);

    expect(client.join).toHaveBeenCalledWith(
      userRoom('11111111-1111-4111-8111-111111111111'),
    );
    jest.advanceTimersByTime(1_000);
    await Promise.resolve();
    await Promise.resolve();
    expect(client.disconnect).toHaveBeenCalledWith(true);
    expect(disconnectListener).toBeDefined();
  });

  it('deduplicates sockets that belong to more than one target room', async () => {
    const { gateway } = createGateway();
    const socket = { id: 'socket-one', data: {} };
    const fetchSockets = jest.fn().mockResolvedValue([socket, socket]);
    const namespace = {
      use: jest.fn(),
      in: jest.fn().mockReturnValue({ fetchSockets }),
    } as unknown as Namespace;
    gateway.namespace = namespace;

    await expect(
      gateway.findSocketsForUsers(['user-one', 'user-two']),
    ).resolves.toEqual([socket]);
    expect(namespace.in).toHaveBeenCalledWith([
      userRoom('user-one'),
      userRoom('user-two'),
    ]);
  });

  it('caps authenticated connections per user and releases capacity on disconnect', async () => {
    const { gateway } = createGateway(1);
    let firstDisconnectListener: (() => void) | undefined;
    const first = {
      data: {
        userId: '11111111-1111-4111-8111-111111111111',
        sessionId: 'session-one',
        tokenExpiresAt: NOW.getTime() + 60_000,
      },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      connected: true,
      once: jest.fn().mockImplementation((_event, listener) => {
        firstDisconnectListener = listener;
      }),
    };
    const second = {
      data: { ...first.data, sessionId: 'session-two' },
      join: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn(),
      connected: true,
      once: jest.fn(),
    };

    await gateway.handleConnection(first as never);
    await gateway.handleConnection(second as never);
    expect(second.disconnect).toHaveBeenCalledWith(true);
    expect(second.join).not.toHaveBeenCalled();

    firstDisconnectListener?.();
    await gateway.handleConnection(second as never);
    expect(second.join).toHaveBeenCalledWith(userRoom(first.data.userId));
  });
});

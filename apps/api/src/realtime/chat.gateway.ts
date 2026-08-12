import {
  WebSocketGateway,
  WebSocketServer,
  type OnGatewayConnection,
  type OnGatewayInit,
} from '@nestjs/websockets';
import { ConfigService } from '@nestjs/config';
import type { Namespace, Socket } from 'socket.io';
import { Clock } from '../auth/providers/clock';
import {
  RealtimeAuthenticationError,
  RealtimeAuthenticator,
} from './realtime-authenticator';
import {
  CHAT_NAMESPACE,
  type AuthenticatedChatSocket,
  type RealtimeSocketTarget,
} from './realtime.types';

type ConnectionMiddlewareNext = (error?: Error) => void;

@WebSocketGateway({
  namespace: CHAT_NAMESPACE,
  serveClient: false,
  maxHttpBufferSize: 64 * 1024,
})
export class ChatGateway
  implements OnGatewayInit<Namespace>, OnGatewayConnection
{
  @WebSocketServer()
  namespace!: Namespace;

  private readonly expiryTimers = new WeakMap<Socket, NodeJS.Timeout>();
  private readonly connectionsByUser = new Map<
    string,
    Set<AuthenticatedChatSocket>
  >();
  private readonly maximumConnectionsPerUser: number;

  constructor(
    private readonly authenticator: RealtimeAuthenticator,
    private readonly clock: Clock,
    config: ConfigService,
  ) {
    this.maximumConnectionsPerUser = config.get<number>(
      'REALTIME_MAX_CONNECTIONS_PER_USER',
      5,
    );
  }

  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.authenticateConnection(socket, next);
    });
  }

  async handleConnection(client: AuthenticatedChatSocket): Promise<void> {
    const expiresInMilliseconds =
      client.data.tokenExpiresAt - this.clock.now().getTime();
    if (expiresInMilliseconds <= 0) {
      client.disconnect(true);
      return;
    }

    if (!this.reserveConnection(client)) {
      client.disconnect(true);
      return;
    }

    client.once('disconnect', () => {
      this.releaseConnection(client);
    });

    const expiryTimer = setTimeout(() => {
      client.disconnect(true);
    }, expiresInMilliseconds);
    expiryTimer.unref();
    this.expiryTimers.set(client, expiryTimer);

    try {
      await client.join(userRoom(client.data.userId));
    } catch {
      this.releaseConnection(client);
      client.disconnect(true);
      return;
    }
  }

  async findSocketsForUsers(
    userIds: string[],
  ): Promise<RealtimeSocketTarget[]> {
    if (userIds.length === 0 || !this.namespace) return [];

    const sockets = await this.namespace
      .in(userIds.map((userId) => userRoom(userId)))
      .fetchSockets();
    const uniqueSockets = new Map<string, RealtimeSocketTarget>();
    for (const socket of sockets) {
      uniqueSockets.set(socket.id, socket as unknown as RealtimeSocketTarget);
    }
    return [...uniqueSockets.values()];
  }

  private reserveConnection(client: AuthenticatedChatSocket): boolean {
    const userId = client.data.userId;
    const connections = this.connectionsByUser.get(userId) ?? new Set();
    if (connections.size >= this.maximumConnectionsPerUser) return false;
    connections.add(client);
    this.connectionsByUser.set(userId, connections);
    return true;
  }

  private releaseConnection(client: AuthenticatedChatSocket): void {
    const timer = this.expiryTimers.get(client);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(client);

    const connections = this.connectionsByUser.get(client.data.userId);
    if (!connections) return;
    connections.delete(client);
    if (connections.size === 0) {
      this.connectionsByUser.delete(client.data.userId);
    }
  }

  private async authenticateConnection(
    socket: Socket,
    next: ConnectionMiddlewareNext,
  ): Promise<void> {
    try {
      socket.data = await this.authenticator.authenticate(socket);
      next();
    } catch {
      next(new RealtimeAuthenticationError());
    }
  }
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

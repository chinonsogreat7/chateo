import {
  Ack,
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  ConnectedSocket,
  MessageBody,
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
  PRESENCE_SUBSCRIBE_COMMAND,
  PRESENCE_UNSUBSCRIBE_COMMAND,
  TYPING_START_COMMAND,
  TYPING_STOP_COMMAND,
  type AuthenticatedChatSocket,
  type ConversationCommandPayload,
  type PresenceSubscriptionData,
  type PresenceUnsubscriptionData,
  type RealtimeAckCallback,
  type RealtimeSocketTarget,
  type TypingStartedData,
  type TypingStoppedData,
} from './realtime.types';
import { ChatStateService } from './chat-state.service';

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
    private readonly state: ChatStateService,
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
      void this.state.disconnect(client, false).finally(() => {
        client.disconnect(true);
      });
    }, expiresInMilliseconds);
    expiryTimer.unref();
    this.expiryTimers.set(client, expiryTimer);

    try {
      await client.join(userRoom(client.data.userId));
      // A disconnect can race the asynchronous room join. The disconnect
      // handler has already released the connection in that case, so never
      // re-register a ghost socket as online.
      if (!client.connected) return;
      this.state.register(client);
    } catch {
      this.releaseConnection(client);
      client.disconnect(true);
      return;
    }
  }

  @SubscribeMessage(PRESENCE_SUBSCRIBE_COMMAND)
  async subscribeToPresence(
    @ConnectedSocket() client: AuthenticatedChatSocket,
    @MessageBody() payload: ConversationCommandPayload,
    @Ack() ack: RealtimeAckCallback<PresenceSubscriptionData>,
  ): Promise<void> {
    await this.state.subscribe(client, payload, ack);
  }

  @SubscribeMessage(PRESENCE_UNSUBSCRIBE_COMMAND)
  async unsubscribeFromPresence(
    @ConnectedSocket() client: AuthenticatedChatSocket,
    @MessageBody() payload: ConversationCommandPayload,
    @Ack() ack: RealtimeAckCallback<PresenceUnsubscriptionData>,
  ): Promise<void> {
    await this.state.unsubscribe(client, payload, ack);
  }

  @SubscribeMessage(TYPING_START_COMMAND)
  async startTyping(
    @ConnectedSocket() client: AuthenticatedChatSocket,
    @MessageBody() payload: ConversationCommandPayload,
    @Ack() ack: RealtimeAckCallback<TypingStartedData>,
  ): Promise<void> {
    await this.state.startTyping(client, payload, ack);
  }

  @SubscribeMessage(TYPING_STOP_COMMAND)
  async stopTyping(
    @ConnectedSocket() client: AuthenticatedChatSocket,
    @MessageBody() payload: ConversationCommandPayload,
    @Ack() ack: RealtimeAckCallback<TypingStoppedData>,
  ): Promise<void> {
    await this.state.stopTyping(client, payload, ack);
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
    void this.state.disconnect(client).catch(() => undefined);
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

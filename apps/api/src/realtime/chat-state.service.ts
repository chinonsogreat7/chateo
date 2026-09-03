import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Socket } from 'socket.io';
import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import {
  PRESENCE_CHANGED_EVENT,
  REALTIME_AUTH_ERROR_CODE,
  REALTIME_AUTH_ERROR_MESSAGE,
  REALTIME_CONVERSATION_ERROR_CODE,
  REALTIME_CONVERSATION_ERROR_MESSAGE,
  REALTIME_INTERNAL_ERROR_CODE,
  REALTIME_INTERNAL_ERROR_MESSAGE,
  REALTIME_PAYLOAD_ERROR_CODE,
  REALTIME_PAYLOAD_ERROR_MESSAGE,
  REALTIME_RATE_LIMIT_ERROR_CODE,
  REALTIME_RATE_LIMIT_ERROR_MESSAGE,
  TYPING_STARTED_EVENT,
  TYPING_STOPPED_EVENT,
  type AuthenticatedChatSocket,
  type ChatServerToClientEvents,
  type ConversationCommandPayload,
  type PresenceChangedEventPayload,
  type PresenceSubscriptionData,
  type PresenceUnsubscriptionData,
  type RealtimeAck,
  type RealtimeAckCallback,
  type RealtimeErrorCode,
  type TypingStartedData,
  type TypingStartedEventPayload,
  type TypingStoppedData,
  type TypingStoppedEventPayload,
} from './realtime.types';

interface ConversationSubscription {
  participantIds: string[];
}

interface TypingState {
  expiresAt: Date;
  timer: NodeJS.Timeout;
  participantIds: string[];
}

interface CommandWindow {
  startedAt: number;
  count: number;
}

interface ClientState {
  subscriptions: Map<string, ConversationSubscription>;
  typing: Map<string, TypingState>;
  commandWindow: CommandWindow;
}

const DEFAULT_TYPING_TTL_MS = 5_000;
const DEFAULT_COMMAND_LIMIT = 30;
const DEFAULT_COMMAND_WINDOW_MS = 10_000;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 20;
const OFFLINE_GRACE_MS = 10_000;
const SESSION_SWEEP_INTERVAL_MS = 30_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class ChatStateService implements OnModuleDestroy {
  private readonly clients = new Map<string, ClientState>();
  private readonly localSockets = new Map<string, AuthenticatedChatSocket>();
  private readonly onlineSocketIdsByUser = new Map<string, Set<string>>();
  private readonly typingSocketIdsByConversationAndUser = new Map<
    string,
    Set<string>
  >();
  private readonly offlineTimersByUser = new Map<string, NodeJS.Timeout>();
  private readonly sessionSweepTimer: NodeJS.Timeout;

  constructor(
    private readonly conversations: RealtimeConversationsRepository,
    private readonly authRepository: AuthRepository,
    private readonly clock: Clock,
  ) {
    this.sessionSweepTimer = setInterval(() => {
      void this.sweepInvalidSessions();
    }, SESSION_SWEEP_INTERVAL_MS);
    this.sessionSweepTimer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.sessionSweepTimer);
    for (const timer of this.offlineTimersByUser.values()) clearTimeout(timer);
    for (const state of this.clients.values()) {
      for (const typing of state.typing.values()) clearTimeout(typing.timer);
    }
  }

  register(client: AuthenticatedChatSocket): void {
    if (this.clients.has(client.id)) return;
    const wasOnline = this.isUserOnline(client.data.userId);
    const pendingOffline = this.offlineTimersByUser.get(client.data.userId);
    if (pendingOffline) {
      clearTimeout(pendingOffline);
      this.offlineTimersByUser.delete(client.data.userId);
    }
    this.clients.set(client.id, {
      subscriptions: new Map(),
      typing: new Map(),
      commandWindow: { startedAt: this.clock.now().getTime(), count: 0 },
    });

    const socketIds =
      this.onlineSocketIdsByUser.get(client.data.userId) ?? new Set<string>();
    socketIds.add(client.id);
    this.onlineSocketIdsByUser.set(client.data.userId, socketIds);
    this.localSockets.set(client.id, client);
    if (!wasOnline && !pendingOffline) {
      void this.emitUserPresenceToSubscribers(
        client.data.userId,
        'online',
      ).catch(() => undefined);
    }
  }

  async subscribe(
    client: AuthenticatedChatSocket,
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<PresenceSubscriptionData>,
  ): Promise<void> {
    const conversationId = this.readConversationId(payload);
    if (!conversationId) return this.ack(ack, payloadError());
    const state = this.clients.get(client.id);
    if (!state) return this.ack(ack, authError());
    if (!this.consumeCommand(state)) return this.ack(ack, rateLimitError());

    const access = await this.authorize(client, conversationId);
    if (!access.ok) {
      await this.removeCachedConversationAccess(client, state, conversationId);
      return this.ack(ack, access.error);
    }
    if (!this.isCurrentClientState(client, state)) {
      return this.ack(ack, authError());
    }
    await this.pruneInvalidParticipantSockets(access.participantIds, client.id);
    if (!this.isCurrentClientState(client, state)) {
      return this.ack(ack, authError());
    }
    if (
      !state.subscriptions.has(conversationId) &&
      state.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_SOCKET
    ) {
      return this.ack(ack, rateLimitError());
    }

    state.subscriptions.set(conversationId, {
      participantIds: access.participantIds,
    });
    const participants = access.participantIds.map((userId) => ({
      userId,
      status: this.isUserOnline(userId)
        ? ('online' as const)
        : ('offline' as const),
    }));
    const typing = this.activeTypingSnapshot(
      conversationId,
      access.participantIds,
      client.data.userId,
    );

    this.ack(ack, {
      ok: true,
      data: { conversationId, participants, typing },
    });
  }

  async unsubscribe(
    client: AuthenticatedChatSocket,
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<PresenceUnsubscriptionData>,
  ): Promise<void> {
    const conversationId = this.readConversationId(payload);
    if (!conversationId) return this.ack(ack, payloadError());
    const state = this.clients.get(client.id);
    if (!state) return this.ack(ack, authError());
    if (!this.consumeCommand(state)) return this.ack(ack, rateLimitError());

    const subscription = state.subscriptions.get(conversationId);
    if (!subscription) {
      const access = await this.authorize(client, conversationId);
      if (!access.ok) return this.ack(ack, access.error);
      this.ack(ack, { ok: true, data: { conversationId } });
      return;
    }

    await this.stopTypingInternal(client, conversationId, true);
    state.subscriptions.delete(conversationId);
    this.ack(ack, { ok: true, data: { conversationId } });
  }

  async startTyping(
    client: AuthenticatedChatSocket,
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<TypingStartedData>,
  ): Promise<void> {
    const conversationId = this.readConversationId(payload);
    if (!conversationId) return this.ack(ack, payloadError());
    const state = this.clients.get(client.id);
    if (!state) return this.ack(ack, authError());
    if (!this.consumeCommand(state)) return this.ack(ack, rateLimitError());

    const access = await this.authorize(client, conversationId);
    if (!access.ok) {
      await this.removeCachedConversationAccess(client, state, conversationId);
      return this.ack(ack, access.error);
    }
    if (!this.isCurrentClientState(client, state)) {
      return this.ack(ack, authError());
    }
    this.clearTypingTimer(state, conversationId);

    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + DEFAULT_TYPING_TTL_MS);
    const timer = setTimeout(() => {
      void this.stopTypingInternal(client, conversationId, true);
    }, DEFAULT_TYPING_TTL_MS);
    timer.unref();
    state.typing.set(conversationId, {
      expiresAt,
      timer,
      participantIds: access.participantIds,
    });
    this.addTypingSocket(client, conversationId);

    this.ack(ack, {
      ok: true,
      data: { conversationId, expiresAt: expiresAt.toISOString() },
    });
    await this.emitTypingStarted(
      client,
      conversationId,
      access.participantIds,
      expiresAt,
    );
  }

  async stopTyping(
    client: AuthenticatedChatSocket,
    payload: ConversationCommandPayload,
    ack: RealtimeAckCallback<TypingStoppedData>,
  ): Promise<void> {
    const conversationId = this.readConversationId(payload);
    if (!conversationId) return this.ack(ack, payloadError());
    const state = this.clients.get(client.id);
    if (!state) return this.ack(ack, authError());

    // Remove active local state before awaiting authorization so concurrent
    // stop commands cannot all bypass the rate limit and amplify DB work.
    const hadActiveTyping = state.typing.has(conversationId);
    const stopping = hadActiveTyping
      ? this.stopTypingInternal(client, conversationId, true)
      : null;
    if (!this.consumeCommand(state)) {
      await stopping;
      if (hadActiveTyping) {
        this.ack(ack, { ok: true, data: { conversationId } });
        return;
      }
      return this.ack(ack, rateLimitError());
    }
    const access = await this.authorize(client, conversationId);
    if (!access.ok) {
      await stopping;
      return this.ack(ack, access.error);
    }
    await (stopping ?? this.stopTypingInternal(client, conversationId, true));
    this.ack(ack, { ok: true, data: { conversationId } });
  }

  async disconnect(
    client: AuthenticatedChatSocket,
    useOfflineGrace = true,
  ): Promise<void> {
    const state = this.clients.get(client.id);
    if (!state) return;

    for (const conversationId of state.typing.keys()) {
      await this.stopTypingInternal(client, conversationId, true);
    }

    this.clients.delete(client.id);
    this.localSockets.delete(client.id);
    const socketIds = this.onlineSocketIdsByUser.get(client.data.userId);
    socketIds?.delete(client.id);
    if (socketIds?.size === 0) {
      this.onlineSocketIdsByUser.delete(client.data.userId);
      if (!useOfflineGrace) {
        const pending = this.offlineTimersByUser.get(client.data.userId);
        if (pending) clearTimeout(pending);
        this.offlineTimersByUser.delete(client.data.userId);
        await this.emitUserPresenceToSubscribers(client.data.userId, 'offline');
        return;
      }
      const timer = setTimeout(() => {
        this.offlineTimersByUser.delete(client.data.userId);
        if (!this.isUserOnline(client.data.userId)) {
          void this.emitUserPresenceToSubscribers(
            client.data.userId,
            'offline',
          ).catch(() => undefined);
        }
      }, OFFLINE_GRACE_MS);
      timer.unref();
      this.offlineTimersByUser.set(client.data.userId, timer);
    }
  }

  private async authorize(
    client: AuthenticatedChatSocket,
    conversationId: string,
  ): Promise<
    | { ok: true; participantIds: string[] }
    | { ok: false; error: RealtimeAck<never> }
  > {
    const now = this.clock.now();
    if (client.data.tokenExpiresAt <= now.getTime()) {
      client.disconnect(true);
      return { ok: false, error: authError() };
    }

    try {
      const active = await this.authRepository.isSessionActive(
        client.data.sessionId,
        client.data.userId,
        now,
      );
      if (!active) {
        client.disconnect(true);
        return { ok: false, error: authError() };
      }
      const conversation = await this.conversations.findAccessibleConversation(
        conversationId,
        client.data.userId,
      );
      if (!conversation) {
        return { ok: false, error: conversationError() };
      }
      return { ok: true, participantIds: conversation.participantIds };
    } catch {
      return { ok: false, error: internalError() };
    }
  }

  private async stopTypingInternal(
    client: AuthenticatedChatSocket,
    conversationId: string,
    emit: boolean,
  ): Promise<void> {
    const state = this.clients.get(client.id);
    const typing = state?.typing.get(conversationId);
    if (!state || !typing) return;
    this.clearTypingTimer(state, conversationId);
    this.removeTypingSocket(client, conversationId);
    if (emit && !this.isUserTyping(client.data.userId, conversationId)) {
      await this.emitTypingStopped(
        client,
        conversationId,
        typing.participantIds,
      );
    }
  }

  private async emitUserPresenceToSubscribers(
    userId: string,
    status: 'online' | 'offline',
  ): Promise<void> {
    for (const [socketId, state] of this.clients) {
      const target = this.findLocalSocket(socketId);
      if (!target) continue;
      for (const [conversationId, subscription] of state.subscriptions) {
        if (!subscription.participantIds.includes(userId)) continue;
        const currentSubscription = await this.reauthorizeSubscription(
          target,
          state,
          conversationId,
        );
        if (!currentSubscription?.participantIds.includes(userId)) continue;
        const payload: PresenceChangedEventPayload = {
          conversationId,
          userId,
          status,
          occurredAt: this.clock.now().toISOString(),
        };
        await this.emitIfActive(target, PRESENCE_CHANGED_EVENT, payload);
      }
    }
  }

  private async emitTypingStarted(
    source: AuthenticatedChatSocket,
    conversationId: string,
    participantIds: string[],
    expiresAt: Date,
  ): Promise<void> {
    const payload: TypingStartedEventPayload = {
      conversationId,
      userId: source.data.userId,
      expiresAt: expiresAt.toISOString(),
    };
    await this.emitToSubscribedParticipants(
      source,
      conversationId,
      participantIds,
      TYPING_STARTED_EVENT,
      payload,
    );
  }

  private async emitTypingStopped(
    source: AuthenticatedChatSocket,
    conversationId: string,
    participantIds: string[],
  ): Promise<void> {
    const payload: TypingStoppedEventPayload = {
      conversationId,
      userId: source.data.userId,
      occurredAt: this.clock.now().toISOString(),
    };
    await this.emitToSubscribedParticipants(
      source,
      conversationId,
      participantIds,
      TYPING_STOPPED_EVENT,
      payload,
    );
  }

  private async emitToSubscribedParticipants(
    source: AuthenticatedChatSocket,
    conversationId: string,
    participantIds: string[],
    event: keyof ChatServerToClientEvents,
    payload: unknown,
  ): Promise<void> {
    const allowedUsers = new Set(participantIds);
    for (const [socketId, state] of this.clients) {
      if (!state.subscriptions.has(conversationId)) continue;
      const target = this.findLocalSocket(socketId);
      if (
        !target ||
        target.data.userId === source.data.userId ||
        !allowedUsers.has(target.data.userId)
      ) {
        continue;
      }
      const subscription = await this.reauthorizeSubscription(
        target,
        state,
        conversationId,
      );
      if (!subscription?.participantIds.includes(source.data.userId)) continue;
      await this.emitIfActive(target, event, payload);
    }
  }

  private async reauthorizeSubscription(
    target: AuthenticatedChatSocket,
    state: ClientState,
    conversationId: string,
  ): Promise<ConversationSubscription | null> {
    if (!this.isCurrentClientState(target, state)) return null;

    const access = await this.authorize(target, conversationId);
    if (!access.ok) {
      await this.removeCachedConversationAccess(target, state, conversationId);
      return null;
    }
    if (!this.isCurrentClientState(target, state)) return null;

    const subscription = { participantIds: access.participantIds };
    state.subscriptions.set(conversationId, subscription);
    return subscription;
  }

  private async removeCachedConversationAccess(
    target: AuthenticatedChatSocket,
    state: ClientState,
    conversationId: string,
  ): Promise<void> {
    if (this.clients.get(target.id) !== state) return;

    // Clearing without fan-out prevents a stale typing.stop from crossing the
    // same access boundary that invalidated this cached subscription.
    await this.stopTypingInternal(target, conversationId, false);
    if (this.clients.get(target.id) === state) {
      state.subscriptions.delete(conversationId);
    }
  }

  private async emitIfActive(
    target: AuthenticatedChatSocket,
    event: keyof ChatServerToClientEvents,
    payload: unknown,
  ): Promise<void> {
    const now = this.clock.now();
    if (target.data.tokenExpiresAt <= now.getTime()) {
      target.disconnect(true);
      return;
    }
    try {
      const active = await this.authRepository.isSessionActive(
        target.data.sessionId,
        target.data.userId,
        now,
      );
      if (!active) {
        target.disconnect(true);
        return;
      }
      (target as unknown as Socket).emit(event, payload);
    } catch {
      target.disconnect(true);
    }
  }

  private async pruneInvalidParticipantSockets(
    participantIds: string[],
    exceptSocketId?: string,
  ): Promise<void> {
    const allowedUsers = new Set(participantIds);
    const candidates = [...this.localSockets.values()].filter(
      (socket) =>
        socket.id !== exceptSocketId && allowedUsers.has(socket.data.userId),
    );
    await Promise.all(candidates.map((socket) => this.pruneIfInvalid(socket)));
  }

  private async sweepInvalidSessions(): Promise<void> {
    await Promise.all(
      [...this.localSockets.values()].map((socket) =>
        this.pruneIfInvalid(socket),
      ),
    );
  }

  private async pruneIfInvalid(socket: AuthenticatedChatSocket): Promise<void> {
    const now = this.clock.now();
    let active = socket.data.tokenExpiresAt > now.getTime();
    if (active) {
      try {
        active = await this.authRepository.isSessionActive(
          socket.data.sessionId,
          socket.data.userId,
          now,
        );
      } catch {
        active = false;
      }
    }
    if (active) return;

    await this.disconnect(socket, false);
    socket.disconnect(true);
  }

  private findLocalSocket(
    socketId: string,
  ): AuthenticatedChatSocket | undefined {
    return this.localSockets.get(socketId);
  }

  private isUserOnline(userId: string): boolean {
    return (
      (this.onlineSocketIdsByUser.get(userId)?.size ?? 0) > 0 ||
      this.offlineTimersByUser.has(userId)
    );
  }

  private typingKey(userId: string, conversationId: string): string {
    return `${conversationId}:${userId}`;
  }

  private addTypingSocket(
    client: AuthenticatedChatSocket,
    conversationId: string,
  ): void {
    const key = this.typingKey(client.data.userId, conversationId);
    const socketIds =
      this.typingSocketIdsByConversationAndUser.get(key) ?? new Set<string>();
    socketIds.add(client.id);
    this.typingSocketIdsByConversationAndUser.set(key, socketIds);
  }

  private removeTypingSocket(
    client: AuthenticatedChatSocket,
    conversationId: string,
  ): void {
    const key = this.typingKey(client.data.userId, conversationId);
    const socketIds = this.typingSocketIdsByConversationAndUser.get(key);
    socketIds?.delete(client.id);
    if (socketIds?.size === 0) {
      this.typingSocketIdsByConversationAndUser.delete(key);
    }
  }

  private isUserTyping(userId: string, conversationId: string): boolean {
    return (
      (this.typingSocketIdsByConversationAndUser.get(
        this.typingKey(userId, conversationId),
      )?.size ?? 0) > 0
    );
  }

  private activeTypingSnapshot(
    conversationId: string,
    participantIds: string[],
    actorUserId: string,
  ): Array<{ userId: string; expiresAt: string }> {
    const now = this.clock.now().getTime();
    const result: Array<{ userId: string; expiresAt: string }> = [];
    for (const userId of participantIds) {
      if (userId === actorUserId) continue;
      const key = this.typingKey(userId, conversationId);
      const socketIds = this.typingSocketIdsByConversationAndUser.get(key);
      if (!socketIds?.size) continue;
      let latest = 0;
      for (const socketId of socketIds) {
        const expiresAt = this.clients
          .get(socketId)
          ?.typing.get(conversationId)
          ?.expiresAt.getTime();
        if (expiresAt && expiresAt > latest) latest = expiresAt;
      }
      if (latest > now) {
        result.push({ userId, expiresAt: new Date(latest).toISOString() });
      }
    }
    return result;
  }

  private clearTypingTimer(state: ClientState, conversationId: string): void {
    const existing = state.typing.get(conversationId);
    if (existing) clearTimeout(existing.timer);
    state.typing.delete(conversationId);
  }

  private consumeCommand(state: ClientState): boolean {
    const now = this.clock.now().getTime();
    if (now - state.commandWindow.startedAt >= DEFAULT_COMMAND_WINDOW_MS) {
      state.commandWindow = { startedAt: now, count: 1 };
      return true;
    }
    state.commandWindow.count += 1;
    return state.commandWindow.count <= DEFAULT_COMMAND_LIMIT;
  }

  private isCurrentClientState(
    client: AuthenticatedChatSocket,
    state: ClientState,
  ): boolean {
    return client.connected !== false && this.clients.get(client.id) === state;
  }

  private readConversationId(
    payload: ConversationCommandPayload | unknown,
  ): string | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }
    if (
      Object.keys(payload as Record<string, unknown>).length !== 1 ||
      !Object.prototype.hasOwnProperty.call(payload, 'conversationId')
    ) {
      return null;
    }
    const conversationId = (payload as { conversationId?: unknown })
      .conversationId;
    return typeof conversationId === 'string' &&
      UUID_PATTERN.test(conversationId)
      ? conversationId.toLowerCase()
      : null;
  }

  private ack<T>(ack: RealtimeAckCallback<T>, response: RealtimeAck<T>): void {
    if (typeof ack === 'function') ack(response);
  }
}

function error(code: RealtimeErrorCode, message: string): RealtimeAck<never> {
  return { ok: false, error: { code, message } };
}

function authError(): RealtimeAck<never> {
  return error(REALTIME_AUTH_ERROR_CODE, REALTIME_AUTH_ERROR_MESSAGE);
}

function payloadError(): RealtimeAck<never> {
  return error(REALTIME_PAYLOAD_ERROR_CODE, REALTIME_PAYLOAD_ERROR_MESSAGE);
}

function conversationError(): RealtimeAck<never> {
  return error(
    REALTIME_CONVERSATION_ERROR_CODE,
    REALTIME_CONVERSATION_ERROR_MESSAGE,
  );
}

function rateLimitError(): RealtimeAck<never> {
  return error(
    REALTIME_RATE_LIMIT_ERROR_CODE,
    REALTIME_RATE_LIMIT_ERROR_MESSAGE,
  );
}

function internalError(): RealtimeAck<never> {
  return error(REALTIME_INTERNAL_ERROR_CODE, REALTIME_INTERNAL_ERROR_MESSAGE);
}

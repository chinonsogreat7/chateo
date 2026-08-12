import { AuthRepository } from '../auth/auth.repository';
import { Clock } from '../auth/providers/clock';
import { ChatStateService } from './chat-state.service';
import { RealtimeConversationsRepository } from './realtime-conversations.repository';
import {
  PRESENCE_CHANGED_EVENT,
  TYPING_STARTED_EVENT,
  TYPING_STOPPED_EVENT,
  type AuthenticatedChatSocket,
} from './realtime.types';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const USER_ONE_ID = '11111111-1111-4111-8111-111111111111';
const USER_TWO_ID = '22222222-2222-4222-8222-222222222222';

function socket(
  id: string,
  userId: string,
  sessionId = `session-${id}`,
): AuthenticatedChatSocket {
  return {
    id,
    connected: true,
    data: {
      userId,
      sessionId,
      tokenExpiresAt: NOW.getTime() + 60_000,
    },
    emit: jest.fn(),
    disconnect: jest.fn(),
  } as unknown as AuthenticatedChatSocket;
}

function createService() {
  const findAccessibleConversation = jest.fn().mockResolvedValue({
    conversationId: CONVERSATION_ID,
    participantIds: [USER_ONE_ID, USER_TWO_ID],
  });
  const isSessionActive = jest.fn().mockResolvedValue(true);
  const now = jest.fn().mockReturnValue(NOW);
  const service = new ChatStateService(
    {
      findAccessibleConversation,
    } as unknown as RealtimeConversationsRepository,
    { isSessionActive } as unknown as AuthRepository,
    { now } as unknown as Clock,
  );
  return { findAccessibleConversation, isSessionActive, now, service };
}

async function subscribe(
  service: ChatStateService,
  client: AuthenticatedChatSocket,
) {
  const ack = jest.fn();
  await service.subscribe(client, { conversationId: CONVERSATION_ID }, ack);
  return ack;
}

describe('ChatStateService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('authorizes subscriptions and returns presence plus typing snapshots', async () => {
    const { service } = createService();
    const first = socket('one', USER_ONE_ID);
    const second = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(second);

    const ack = await subscribe(service, first);

    expect(ack).toHaveBeenCalledWith({
      ok: true,
      data: {
        conversationId: CONVERSATION_ID,
        participants: [
          { userId: USER_ONE_ID, status: 'online' },
          { userId: USER_TWO_ID, status: 'online' },
        ],
        typing: [],
      },
    });
  });

  it('returns the same not-found error for missing conversations and outsiders', async () => {
    const { findAccessibleConversation, service } = createService();
    findAccessibleConversation.mockResolvedValue(null);
    const outsider = socket('outsider', USER_ONE_ID);
    service.register(outsider);
    const ack = await subscribe(service, outsider);

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: {
        code: 'REALTIME_CONVERSATION_NOT_FOUND',
        message: 'Conversation was not found.',
      },
    });
  });

  it('rejects payloads with extra keys before repository access', async () => {
    const { findAccessibleConversation, service } = createService();
    const client = socket('one', USER_ONE_ID);
    service.register(client);
    const ack = jest.fn();

    await service.startTyping(
      client,
      { conversationId: CONVERSATION_ID, targetUserId: USER_TWO_ID } as never,
      ack,
    );

    expect(ack.mock.calls[0]?.[0]).toMatchObject({
      ok: false,
      error: { code: 'REALTIME_PAYLOAD_INVALID' },
    });
    expect(findAccessibleConversation).not.toHaveBeenCalled();
  });

  it('emits every typing refresh and automatically emits stop at the refreshed TTL', async () => {
    jest.useFakeTimers();
    const { now, service } = createService();
    const first = socket('one', USER_ONE_ID);
    const second = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(second);
    await subscribe(service, first);
    await subscribe(service, second);

    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    now.mockReturnValue(new Date(NOW.getTime() + 1_000));
    jest.advanceTimersByTime(1_000);
    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );

    expect(second.emit).toHaveBeenCalledTimes(2);
    expect(second.emit).toHaveBeenNthCalledWith(
      1,
      TYPING_STARTED_EVENT,
      expect.objectContaining({ expiresAt: '2026-08-12T12:00:05.000Z' }),
    );
    expect(second.emit).toHaveBeenNthCalledWith(
      2,
      TYPING_STARTED_EVENT,
      expect.objectContaining({ expiresAt: '2026-08-12T12:00:06.000Z' }),
    );

    jest.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(second.emit).toHaveBeenLastCalledWith(
      TYPING_STOPPED_EVENT,
      expect.objectContaining({ userId: USER_ONE_ID }),
    );
  });

  it('aggregates typing across devices and excludes the actor other devices', async () => {
    const { service } = createService();
    const first = socket('one-a', USER_ONE_ID);
    const sameUser = socket('one-b', USER_ONE_ID);
    const peer = socket('two', USER_TWO_ID);
    for (const client of [first, sameUser, peer]) {
      service.register(client);
      await subscribe(service, client);
    }

    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    await service.startTyping(
      sameUser,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    await service.stopTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );

    expect(sameUser.emit).not.toHaveBeenCalledWith(
      TYPING_STARTED_EVENT,
      expect.anything(),
    );
    expect(peer.emit).toHaveBeenCalledWith(
      TYPING_STARTED_EVENT,
      expect.anything(),
    );
    expect(peer.emit).not.toHaveBeenCalledWith(
      TYPING_STOPPED_EVENT,
      expect.anything(),
    );
  });

  it('cleans typing on disconnect and delays offline to avoid reconnect flicker', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    const first = socket('one', USER_ONE_ID);
    const peer = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(peer);
    await subscribe(service, first);
    await subscribe(service, peer);
    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );

    await service.disconnect(first);
    expect(peer.emit).toHaveBeenCalledWith(
      TYPING_STOPPED_EVENT,
      expect.anything(),
    );
    expect(peer.emit).not.toHaveBeenCalledWith(
      PRESENCE_CHANGED_EVENT,
      expect.objectContaining({ status: 'offline' }),
    );

    jest.advanceTimersByTime(10_000);
    await Promise.resolve();
    expect(peer.emit).toHaveBeenCalledWith(
      PRESENCE_CHANGED_EVENT,
      expect.objectContaining({ userId: USER_ONE_ID, status: 'offline' }),
    );
  });

  it('cancels the offline transition when the user reconnects during grace', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    const first = socket('one-a', USER_ONE_ID);
    const peer = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(peer);
    await subscribe(service, peer);

    await service.disconnect(first);
    service.register(socket('one-b', USER_ONE_ID));
    jest.advanceTimersByTime(10_000);
    await Promise.resolve();

    expect(peer.emit).not.toHaveBeenCalledWith(
      PRESENCE_CHANGED_EVENT,
      expect.objectContaining({ userId: USER_ONE_ID, status: 'offline' }),
    );
  });

  it('keeps new subscription snapshots online during the reconnect grace', async () => {
    jest.useFakeTimers();
    const { service } = createService();
    const first = socket('one', USER_ONE_ID);
    const peer = socket('two-a', USER_TWO_ID);
    service.register(first);
    service.register(peer);
    await service.disconnect(first);

    const secondPeerDevice = socket('two-b', USER_TWO_ID);
    service.register(secondPeerDevice);
    const ack = await subscribe(service, secondPeerDevice);

    expect(ack).toHaveBeenCalledWith({
      ok: true,
      data: expect.objectContaining({
        participants: expect.arrayContaining([
          { userId: USER_ONE_ID, status: 'online' },
        ]),
      }),
    });
  });

  it('does not leave ghost typing state when disconnect races authorization', async () => {
    const { findAccessibleConversation, service } = createService();
    let resolveAccess: ((value: unknown) => void) | undefined;
    findAccessibleConversation.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAccess = resolve;
        }),
    );
    const client = socket('one', USER_ONE_ID);
    const peer = socket('two', USER_TWO_ID);
    service.register(client);
    service.register(peer);
    const ack = jest.fn();

    const pending = service.startTyping(
      client,
      { conversationId: CONVERSATION_ID },
      ack,
    );
    await Promise.resolve();
    await Promise.resolve();
    (client as unknown as { connected: boolean }).connected = false;
    await service.disconnect(client);
    resolveAccess?.({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ONE_ID, USER_TWO_ID],
    });
    await pending;

    expect(ack).toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ code: 'AUTH_ACCESS_TOKEN_INVALID' }),
    });
    expect(peer.emit).not.toHaveBeenCalledWith(
      TYPING_STARTED_EVENT,
      expect.anything(),
    );
  });

  it('rate limits repeated starts but always accepts a stop for active typing', async () => {
    const { service } = createService();
    const client = socket('one', USER_ONE_ID);
    service.register(client);
    const startAck = jest.fn();
    for (let index = 0; index < 31; index += 1) {
      await service.startTyping(
        client,
        { conversationId: CONVERSATION_ID },
        startAck,
      );
    }
    expect(startAck.mock.calls[30]?.[0]).toMatchObject({
      ok: false,
      error: { code: 'REALTIME_RATE_LIMITED' },
    });

    const stopAck = jest.fn();
    await service.stopTyping(
      client,
      { conversationId: CONVERSATION_ID },
      stopAck,
    );
    expect(stopAck).toHaveBeenCalledWith({
      ok: true,
      data: { conversationId: CONVERSATION_ID },
    });
  });

  it('clears an active stop without another repository query after the command budget is exhausted', async () => {
    const { findAccessibleConversation, service } = createService();
    const client = socket('one', USER_ONE_ID);
    service.register(client);
    await service.startTyping(
      client,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    for (let index = 0; index < 29; index += 1) {
      await service.subscribe(
        client,
        { conversationId: CONVERSATION_ID },
        jest.fn(),
      );
    }
    const callsBeforeStop = findAccessibleConversation.mock.calls.length;
    const stopAck = jest.fn();

    await service.stopTyping(
      client,
      { conversationId: CONVERSATION_ID },
      stopAck,
    );

    expect(stopAck).toHaveBeenCalledWith({
      ok: true,
      data: { conversationId: CONVERSATION_ID },
    });
    expect(findAccessibleConversation).toHaveBeenCalledTimes(callsBeforeStop);
  });

  it('fails closed when a subscribed target session is revoked', async () => {
    const { isSessionActive, service } = createService();
    const first = socket('one', USER_ONE_ID);
    const revoked = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(revoked);
    await subscribe(service, first);
    await subscribe(service, revoked);
    (revoked.emit as jest.Mock).mockClear();
    isSessionActive.mockImplementation((sessionId: string) =>
      Promise.resolve(sessionId !== revoked.data.sessionId),
    );

    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );

    expect(revoked.emit).not.toHaveBeenCalled();
    expect(revoked.disconnect).toHaveBeenCalledWith(true);
  });
});

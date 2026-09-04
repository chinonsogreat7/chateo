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
const USER_THREE_ID = '33333333-3333-4333-8333-333333333333';

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
  const findGroupParticipantIds = jest
    .fn()
    .mockResolvedValue([USER_ONE_ID, USER_TWO_ID]);
  const isSessionActive = jest.fn().mockResolvedValue(true);
  const findActiveSessionIds = jest.fn(
    async (
      sessions: Array<{ sessionId: string; userId: string }>,
      now: Date,
    ) => {
      const activeSessionIds: string[] = [];
      for (const session of sessions) {
        if (await isSessionActive(session.sessionId, session.userId, now)) {
          activeSessionIds.push(session.sessionId);
        }
      }
      return activeSessionIds;
    },
  );
  const now = jest.fn().mockReturnValue(NOW);
  const service = new ChatStateService(
    {
      findAccessibleConversation,
      findGroupParticipantIds,
    } as unknown as RealtimeConversationsRepository,
    { findActiveSessionIds, isSessionActive } as unknown as AuthRepository,
    { now } as unknown as Clock,
  );
  return {
    findAccessibleConversation,
    findGroupParticipantIds,
    findActiveSessionIds,
    isSessionActive,
    now,
    service,
  };
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

    await jest.advanceTimersByTimeAsync(5_000);
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

    await jest.advanceTimersByTimeAsync(10_000);
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

  it('reauthorizes and removes a blocked cached subscription before typing fan-out', async () => {
    jest.useFakeTimers();
    const { findAccessibleConversation, service } = createService();
    const first = socket('one', USER_ONE_ID);
    const blockedPeer = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(blockedPeer);
    await subscribe(service, first);
    await subscribe(service, blockedPeer);
    await service.startTyping(
      blockedPeer,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    (first.emit as jest.Mock).mockClear();
    (blockedPeer.emit as jest.Mock).mockClear();

    findAccessibleConversation.mockImplementation(
      (_conversationId: string, userId: string) =>
        Promise.resolve(
          userId === USER_TWO_ID
            ? null
            : {
                conversationId: CONVERSATION_ID,
                participantIds: [USER_ONE_ID, USER_TWO_ID],
              },
        ),
    );

    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );

    expect(blockedPeer.emit).not.toHaveBeenCalledWith(
      TYPING_STARTED_EVENT,
      expect.anything(),
    );

    // Restoring repository access does not restore the removed subscription;
    // the peer must explicitly subscribe again.
    findAccessibleConversation.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ONE_ID, USER_TWO_ID],
    });
    await service.startTyping(
      first,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    expect(blockedPeer.emit).not.toHaveBeenCalledWith(
      TYPING_STARTED_EVENT,
      expect.anything(),
    );
    await jest.advanceTimersByTimeAsync(5_000);
    expect(first.emit).not.toHaveBeenCalledWith(
      TYPING_STOPPED_EVENT,
      expect.objectContaining({ userId: USER_TWO_ID }),
    );
  });

  it('reauthorizes and removes a blocked cached subscription before presence fan-out', async () => {
    const { findAccessibleConversation, service } = createService();
    const first = socket('one', USER_ONE_ID);
    const blockedPeer = socket('two', USER_TWO_ID);
    service.register(first);
    service.register(blockedPeer);
    await subscribe(service, blockedPeer);
    (blockedPeer.emit as jest.Mock).mockClear();

    findAccessibleConversation.mockImplementation(
      (_conversationId: string, userId: string) =>
        Promise.resolve(
          userId === USER_TWO_ID
            ? null
            : {
                conversationId: CONVERSATION_ID,
                participantIds: [USER_ONE_ID, USER_TWO_ID],
              },
        ),
    );

    await service.disconnect(first, false);

    expect(blockedPeer.emit).not.toHaveBeenCalledWith(
      PRESENCE_CHANGED_EVENT,
      expect.anything(),
    );

    findAccessibleConversation.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ONE_ID, USER_TWO_ID],
    });
    const unsubscribeAck = jest.fn();
    await service.unsubscribe(
      blockedPeer,
      { conversationId: CONVERSATION_ID },
      unsubscribeAck,
    );
    expect(unsubscribeAck).toHaveBeenCalledWith({
      ok: true,
      data: { conversationId: CONVERSATION_ID },
    });
    expect(findAccessibleConversation).toHaveBeenLastCalledWith(
      CONVERSATION_ID,
      USER_TWO_ID,
    );
  });

  it('refreshes cached participant rosters before a newly added member changes presence', async () => {
    const { findAccessibleConversation, findGroupParticipantIds, service } =
      createService();
    const subscriber = socket('one', USER_ONE_ID);
    const existingMember = socket('two', USER_TWO_ID);
    service.register(subscriber);
    service.register(existingMember);
    await subscribe(service, subscriber);
    (subscriber.emit as jest.Mock).mockClear();

    findGroupParticipantIds.mockResolvedValue([
      USER_ONE_ID,
      USER_TWO_ID,
      USER_THREE_ID,
    ]);
    findAccessibleConversation.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ONE_ID, USER_TWO_ID, USER_THREE_ID],
    });
    await service.refreshConversationAccess(CONVERSATION_ID);

    const addedMember = socket('three', USER_THREE_ID);
    service.register(addedMember);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(subscriber.emit).toHaveBeenCalledWith(PRESENCE_CHANGED_EVENT, {
      conversationId: CONVERSATION_ID,
      userId: USER_THREE_ID,
      status: 'online',
      occurredAt: NOW.toISOString(),
    });
  });

  it('publishes the current presence of a newly visible member who was already connected', async () => {
    const { findGroupParticipantIds, service } = createService();
    const subscriber = socket('one', USER_ONE_ID);
    const existingMember = socket('two', USER_TWO_ID);
    const addedMember = socket('three', USER_THREE_ID);
    service.register(subscriber);
    service.register(existingMember);
    await subscribe(service, subscriber);

    service.register(addedMember);
    await new Promise<void>((resolve) => setImmediate(resolve));
    (subscriber.emit as jest.Mock).mockClear();
    findGroupParticipantIds.mockResolvedValue([
      USER_ONE_ID,
      USER_TWO_ID,
      USER_THREE_ID,
    ]);

    await service.refreshConversationAccess(CONVERSATION_ID);

    expect(subscriber.emit).toHaveBeenCalledWith(PRESENCE_CHANGED_EVENT, {
      conversationId: CONVERSATION_ID,
      userId: USER_THREE_ID,
      status: 'online',
      occurredAt: NOW.toISOString(),
    });
  });

  it('reuses one access lookup when refreshing the same user multiple devices', async () => {
    const { findGroupParticipantIds, isSessionActive, service } =
      createService();
    const first = socket('one-a', USER_ONE_ID);
    const second = socket('one-b', USER_ONE_ID);
    service.register(first);
    service.register(second);
    await subscribe(service, first);
    await subscribe(service, second);
    findGroupParticipantIds.mockClear();
    isSessionActive.mockClear();

    await service.refreshConversationAccess(CONVERSATION_ID);

    expect(findGroupParticipantIds).toHaveBeenCalledTimes(1);
    expect(findGroupParticipantIds).toHaveBeenCalledWith(CONVERSATION_ID);
    expect(isSessionActive).toHaveBeenCalledTimes(2);
  });

  it('serializes overlapping access refreshes so an older roster cannot win', async () => {
    const { findAccessibleConversation, findGroupParticipantIds, service } =
      createService();
    const subscriber = socket('one', USER_ONE_ID);
    service.register(subscriber);
    await subscribe(service, subscriber);
    (subscriber.emit as jest.Mock).mockClear();
    findGroupParticipantIds.mockReset();

    let resolveFirst!: (value: string[]) => void;
    let resolveSecond!: (value: string[]) => void;
    const firstLookup = new Promise<string[]>((resolve) => {
      resolveFirst = resolve;
    });
    const secondLookup = new Promise<string[]>((resolve) => {
      resolveSecond = resolve;
    });
    findGroupParticipantIds
      .mockImplementationOnce(() => firstLookup)
      .mockImplementationOnce(() => secondLookup);

    const firstRefresh = service.refreshConversationAccess(CONVERSATION_ID);
    const secondRefresh = service.refreshConversationAccess(CONVERSATION_ID);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(findGroupParticipantIds).toHaveBeenCalledTimes(1);

    resolveFirst([USER_ONE_ID, USER_TWO_ID]);
    await firstRefresh;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(findGroupParticipantIds).toHaveBeenCalledTimes(2);

    resolveSecond([USER_ONE_ID, USER_TWO_ID, USER_THREE_ID]);
    await secondRefresh;

    findAccessibleConversation.mockResolvedValue({
      conversationId: CONVERSATION_ID,
      participantIds: [USER_ONE_ID, USER_TWO_ID, USER_THREE_ID],
    });
    const addedMember = socket('three', USER_THREE_ID);
    service.register(addedMember);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(subscriber.emit).toHaveBeenLastCalledWith(PRESENCE_CHANGED_EVENT, {
      conversationId: CONVERSATION_ID,
      userId: USER_THREE_ID,
      status: 'online',
      occurredAt: NOW.toISOString(),
    });
  });

  it('evicts removed subscriptions and typing without a stale stop event', async () => {
    jest.useFakeTimers();
    const { findGroupParticipantIds, service } = createService();
    const removedMember = socket('one', USER_ONE_ID);
    const remainingMember = socket('two', USER_TWO_ID);
    service.register(removedMember);
    service.register(remainingMember);
    await subscribe(service, removedMember);
    await subscribe(service, remainingMember);
    await service.startTyping(
      removedMember,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    (removedMember.emit as jest.Mock).mockClear();
    (remainingMember.emit as jest.Mock).mockClear();

    findGroupParticipantIds.mockResolvedValue([USER_TWO_ID]);
    await service.refreshConversationAccess(CONVERSATION_ID);

    await service.startTyping(
      remainingMember,
      { conversationId: CONVERSATION_ID },
      jest.fn(),
    );
    await jest.advanceTimersByTimeAsync(5_000);

    expect(removedMember.emit).not.toHaveBeenCalled();
    expect(remainingMember.emit).not.toHaveBeenCalledWith(
      TYPING_STOPPED_EVENT,
      expect.objectContaining({ userId: USER_ONE_ID }),
    );
  });
});

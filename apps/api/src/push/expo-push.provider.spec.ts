import { ConfigService } from '@nestjs/config';
import { ExpoPushProvider } from './expo-push.provider';

describe('Expo push adapter', () => {
  afterEach(() => jest.restoreAllMocks());
  const provider = () =>
    new ExpoPushProvider(
      new ConfigService({
        PUSH_NOTIFICATIONS_ENABLED: true,
        EXPO_ACCESS_TOKEN: 'server-only-expo-access-token',
      }),
    );
  const delivery = {
    userId: 'user',
    token: 'ExpoPushToken[1234567890abcdef]',
    conversationId: 'chat',
    messageId: 'message',
  };
  it('sends minimal private payloads and validates a provider ticket', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(
          JSON.stringify({ data: [{ status: 'ok', id: 'ticket' }] }),
        ),
      );
    await expect(provider().send(delivery, 'notification')).resolves.toEqual({
      status: 'accepted',
      ticketId: 'ticket',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://exp.host/--/api/v2/push/send',
      expect.objectContaining({
        method: 'POST',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer server-only-expo-access-token',
        },
      }),
    );
    const payload: unknown = JSON.parse(
      fetchMock.mock.calls[0]![1]!.body as string,
    );
    expect(payload).toEqual([
      {
        to: delivery.token,
        title: 'ChatMe',
        body: 'You have a new message.',
        sound: 'default',
        ttl: 3600,
        collapseId: 'notification',
        tag: 'notification',
        data: {
          type: 'message',
          conversationId: 'chat',
          messageId: 'message',
          notificationId: 'notification',
        },
      },
    ]);
  });
  it.each([
    [429, true],
    [503, true],
    [401, false],
    [400, false],
  ] as const)('classifies HTTP %i safely', async (status, retryable) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response('provider body must not be echoed', { status }),
      );
    await expect(provider().send(delivery, 'notification')).resolves.toEqual({
      status: 'error',
      code: `HTTP_${status}`,
      retryable,
    });
  });
  it('handles invalid tokens, malformed tickets and missing receipts', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { status: 'error', details: { error: 'DeviceNotRegistered' } },
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{"data":{}}'))
      .mockResolvedValueOnce(
        new Response('{"data":{"ticket":{"status":"ok"}}}'),
      );
    const client = provider();
    await expect(client.send(delivery, 'notification')).resolves.toEqual({
      status: 'error',
      code: 'DeviceNotRegistered',
      retryable: false,
    });
    await expect(client.send(delivery, 'notification')).resolves.toMatchObject({
      status: 'error',
      retryable: true,
    });
    await expect(client.receipt('ticket')).resolves.toEqual({
      status: 'pending',
    });
    await expect(client.receipt('ticket')).resolves.toEqual({ status: 'ok' });
  });
});

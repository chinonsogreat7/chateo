import { AuthRepository } from '../auth/auth.repository';
import { ChatGateway } from '../realtime/chat.gateway';
import { PushPresenceService } from './push-presence.service';

describe('Push realtime presence', () => {
  it('requires a live unexpired authenticated session, not just a cached socket', async () => {
    const now = new Date('2026-09-11T12:00:00Z');
    const gateway = {
      findSocketsForUsers: jest.fn().mockResolvedValue([
        {
          data: {
            userId: 'user',
            sessionId: 'active',
            tokenExpiresAt: now.getTime() + 60000,
          },
        },
        {
          data: {
            userId: 'user',
            sessionId: 'expired',
            tokenExpiresAt: now.getTime(),
          },
        },
        {
          data: {
            userId: 'other',
            sessionId: 'other',
            tokenExpiresAt: now.getTime() + 60000,
          },
        },
        { data: null },
      ]),
    };
    const auth = {
      findActiveSessionIds: jest.fn().mockResolvedValue(['active']),
    };
    const presence = new PushPresenceService(
      gateway as unknown as ChatGateway,
      auth as unknown as AuthRepository,
    );
    await expect(presence.isOnline('user', now)).resolves.toBe(true);
    expect(auth.findActiveSessionIds).toHaveBeenCalledWith(
      [{ userId: 'user', sessionId: 'active' }],
      now,
    );
    auth.findActiveSessionIds.mockResolvedValue([]);
    await expect(presence.isOnline('user', now)).resolves.toBe(false);
    gateway.findSocketsForUsers.mockRejectedValue(
      new Error('adapter unavailable'),
    );
    await expect(presence.isOnline('user', now)).rejects.toThrow(
      'adapter unavailable',
    );
  });
});

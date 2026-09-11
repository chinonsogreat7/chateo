import { Injectable } from '@nestjs/common';
import { AuthRepository } from '../auth/auth.repository';
import { ChatGateway } from '../realtime/chat.gateway';

@Injectable()
export class PushPresenceService {
  constructor(
    private readonly gateway: ChatGateway,
    private readonly auth: AuthRepository,
  ) {}

  async isOnline(userId: string, now: Date): Promise<boolean> {
    const sockets = await this.gateway.findSocketsForUsers([userId]);
    const sessions = sockets.flatMap((socket) => {
      if (typeof socket.data !== 'object' || socket.data === null) return [];
      const data = socket.data as Record<string, unknown>;
      if (
        data.userId !== userId ||
        typeof data.sessionId !== 'string' ||
        typeof data.tokenExpiresAt !== 'number' ||
        data.tokenExpiresAt <= now.getTime()
      )
        return [];
      return [{ userId, sessionId: data.sessionId }];
    });
    if (sessions.length === 0) return false;
    return (await this.auth.findActiveSessionIds(sessions, now)).length > 0;
  }
}

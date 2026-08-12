import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { AuthenticatedUser } from '../../common/types/authenticated-request';
import type { AuthUserRecord } from '../auth.types';

export interface IssuedAccessToken {
  token: string;
  expiresInSeconds: number;
}

@Injectable()
export class AccessTokenService {
  private readonly expiresInSeconds: number;

  constructor(
    private readonly jwtService: JwtService,
    config: ConfigService,
  ) {
    this.expiresInSeconds = config.get<number>(
      'AUTH_ACCESS_TOKEN_TTL_SECONDS',
      900,
    );
  }

  async issue(
    user: AuthUserRecord,
    sessionId: string,
  ): Promise<IssuedAccessToken> {
    const payload: AuthenticatedUser = {
      sub: user.id,
      sid: sessionId,
      profileComplete: user.profileCompletedAt !== null,
    };
    const token = await this.jwtService.signAsync(payload);
    return { token, expiresInSeconds: this.expiresInSeconds };
  }
}

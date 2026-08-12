import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';

export interface IssuedRefreshToken {
  token: string;
  digest: string;
}

export interface ParsedRefreshToken {
  sessionId: string;
  token: string;
  digest: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class RefreshTokenService {
  issue(sessionId: string): IssuedRefreshToken {
    const secret = randomBytes(32).toString('base64url');
    const token = `${sessionId}.${secret}`;
    return { token, digest: this.digest(token) };
  }

  parse(value: string): ParsedRefreshToken | null {
    const separatorIndex = value.indexOf('.');
    if (separatorIndex < 1) return null;

    const sessionId = value.slice(0, separatorIndex);
    const secret = value.slice(separatorIndex + 1);
    if (!UUID_PATTERN.test(sessionId) || secret.length < 32) return null;

    return {
      sessionId,
      token: value,
      digest: this.digest(value),
    };
  }

  matches(expectedDigest: string, actualDigest: string): boolean {
    const expected = Buffer.from(expectedDigest, 'hex');
    const actual = Buffer.from(actualDigest, 'hex');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }

  private digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }
}

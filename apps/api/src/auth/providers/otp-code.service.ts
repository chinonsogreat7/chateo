import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class OtpCodeService {
  private readonly secret: string;
  private readonly fixedCode: string;
  readonly length: number;

  constructor(config: ConfigService) {
    this.secret = config.getOrThrow<string>('OTP_HASH_SECRET');
    this.fixedCode = config.get<string>('AUTH_FIXED_OTP', '');
    this.length = config.get<number>('AUTH_OTP_LENGTH', 4);
  }

  generate(): string {
    if (this.fixedCode.length > 0) return this.fixedCode;
    return randomInt(0, 10 ** this.length)
      .toString()
      .padStart(this.length, '0');
  }

  digest(challengeId: string, phoneNumber: string, code: string): string {
    return createHmac('sha256', this.secret)
      .update(`${challengeId}:${phoneNumber}:${code}`)
      .digest('hex');
  }

  matches(
    expectedDigest: string,
    challengeId: string,
    phoneNumber: string,
    code: string,
  ): boolean {
    const actualDigest = this.digest(challengeId, phoneNumber, code);
    const expected = Buffer.from(expectedDigest, 'hex');
    const actual = Buffer.from(actualDigest, 'hex');
    return (
      expected.length === actual.length && timingSafeEqual(expected, actual)
    );
  }
}

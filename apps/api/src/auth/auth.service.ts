import { randomUUID } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/errors/api.exception';
import { AuthRepository } from './auth.repository';
import type {
  AuthDevicePlatform,
  AuthSessionRecord,
  AuthUserRecord,
  CreateAuthSessionInput,
  OtpChallengeRecord,
  RequestMetadata,
} from './auth.types';
import type {
  AuthResponseDto,
  OtpChallengeResponseDto,
  UserResponseDto,
} from './dto/auth-response.dto';
import { DevicePlatformInput, type VerifyOtpDto } from './dto/verify-otp.dto';
import { AccessTokenService } from './providers/access-token.service';
import { Clock } from './providers/clock';
import { OtpCodeService } from './providers/otp-code.service';
import { OtpDeliveryProvider } from './providers/otp-delivery.provider';
import { PhoneNumberService } from './providers/phone-number.service';
import { RefreshTokenService } from './providers/refresh-token.service';

@Injectable()
export class AuthService {
  private readonly otpTtlSeconds: number;
  private readonly otpResendSeconds: number;
  private readonly otpMaxAttempts: number;
  private readonly otpLockSeconds: number;
  private readonly refreshTokenTtlSeconds: number;

  constructor(
    private readonly repository: AuthRepository,
    private readonly clock: Clock,
    private readonly otpCodeService: OtpCodeService,
    private readonly otpDeliveryProvider: OtpDeliveryProvider,
    private readonly phoneNumberService: PhoneNumberService,
    private readonly refreshTokenService: RefreshTokenService,
    private readonly accessTokenService: AccessTokenService,
    config: ConfigService,
  ) {
    this.otpTtlSeconds = config.get<number>('AUTH_OTP_TTL_SECONDS', 300);
    this.otpResendSeconds = config.get<number>('AUTH_OTP_RESEND_SECONDS', 24);
    this.otpMaxAttempts = config.get<number>('AUTH_OTP_MAX_ATTEMPTS', 5);
    this.otpLockSeconds = config.get<number>('AUTH_OTP_LOCK_SECONDS', 900);
    this.refreshTokenTtlSeconds = config.get<number>(
      'AUTH_REFRESH_TOKEN_TTL_SECONDS',
      2_592_000,
    );
  }

  async requestOtp(phoneNumberInput: string): Promise<OtpChallengeResponseDto> {
    const phoneNumber = this.phoneNumberService.normalize(phoneNumberInput);
    const now = this.clock.now();
    const latest = await this.repository.getLatestOtpChallenge(phoneNumber);
    this.assertCanResend(latest, now);
    const attemptsRemaining = await this.getAvailableOtpAttempts(
      phoneNumber,
      now,
    );
    return this.issueOtp(phoneNumber, now, attemptsRemaining);
  }

  async resendOtp(challengeId: string): Promise<OtpChallengeResponseDto> {
    const now = this.clock.now();
    const challenge = await this.repository.getOtpChallenge(challengeId);
    if (!challenge || challenge.consumedAt) {
      throw this.invalidChallengeException();
    }

    this.assertCanResend(challenge, now);
    const attemptsRemaining = await this.getAvailableOtpAttempts(
      challenge.phoneNumber,
      now,
    );
    return this.issueOtp(challenge.phoneNumber, now, attemptsRemaining);
  }

  async verifyOtp(
    input: VerifyOtpDto,
    metadata: RequestMetadata,
  ): Promise<AuthResponseDto> {
    if (!new RegExp(`^\\d{${this.otpCodeService.length}}$`).test(input.code)) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'AUTH_OTP_CODE_FORMAT',
        `The verification code must contain exactly ${this.otpCodeService.length} digits.`,
      );
    }

    const now = this.clock.now();
    const challenge = await this.repository.getOtpChallenge(input.challengeId);
    this.assertChallengeCanBeVerified(challenge, now);
    await this.getAvailableOtpAttempts(challenge.phoneNumber, now);

    if (
      !this.otpCodeService.matches(
        challenge.codeDigest,
        challenge.id,
        challenge.phoneNumber,
        input.code,
      )
    ) {
      const failedAttempt = await this.repository.recordFailedOtpAttempt(
        challenge.id,
        challenge.phoneNumber,
        this.otpMaxAttempts,
        this.addSeconds(now, this.otpLockSeconds),
        now,
      );
      if (!failedAttempt) throw this.invalidChallengeException();
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_INVALID_OTP',
        'The verification code is invalid.',
        {
          attemptsRemaining: failedAttempt.attemptsRemaining,
          ...(failedAttempt.lockedUntil
            ? { retryAfterSeconds: this.otpLockSeconds }
            : {}),
        },
      );
    }

    const sessionId = randomUUID();
    const familyId = randomUUID();
    const refreshToken = this.refreshTokenService.issue(sessionId);
    const sessionInput: Omit<CreateAuthSessionInput, 'userId'> = {
      id: sessionId,
      familyId,
      tokenDigest: refreshToken.digest,
      deviceName: this.cleanOptional(input.device?.name, 120),
      platform: this.mapPlatform(input.device?.platform),
      ipAddress: this.cleanOptional(metadata.ipAddress, 64),
      userAgent: this.cleanOptional(metadata.userAgent, 512),
      expiresAt: this.addSeconds(now, this.refreshTokenTtlSeconds),
      lastUsedAt: now,
    };
    const result = await this.repository.completeVerification(
      challenge.id,
      challenge.phoneNumber,
      sessionInput,
      now,
    );
    if (!result) throw this.invalidChallengeException();

    return this.buildAuthResponse(
      result.user,
      result.session,
      refreshToken.token,
    );
  }

  async refresh(refreshTokenValue: string): Promise<AuthResponseDto> {
    const parsed = this.refreshTokenService.parse(refreshTokenValue);
    if (!parsed) throw this.invalidRefreshTokenException();

    const now = this.clock.now();
    const currentSession = await this.repository.getSession(parsed.sessionId);
    if (
      !currentSession ||
      !this.refreshTokenService.matches(
        currentSession.tokenDigest,
        parsed.digest,
      )
    ) {
      throw this.invalidRefreshTokenException();
    }

    if (currentSession.revokedAt) {
      if (currentSession.revokedReason === 'ROTATED') {
        await this.repository.revokeSessionFamily(
          currentSession.familyId,
          now,
          'REUSE_DETECTED',
        );
        throw new ApiException(
          HttpStatus.UNAUTHORIZED,
          'AUTH_REFRESH_TOKEN_REUSED',
          'This refresh token was already used. Sign in again.',
        );
      }
      throw this.invalidRefreshTokenException();
    }

    if (currentSession.expiresAt.getTime() <= now.getTime()) {
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_REFRESH_TOKEN_EXPIRED',
        'The refresh token has expired. Sign in again.',
      );
    }

    const nextSessionId = randomUUID();
    const nextRefreshToken = this.refreshTokenService.issue(nextSessionId);
    const nextSession: CreateAuthSessionInput = {
      id: nextSessionId,
      familyId: currentSession.familyId,
      userId: currentSession.userId,
      tokenDigest: nextRefreshToken.digest,
      deviceName: currentSession.deviceName ?? undefined,
      platform: currentSession.platform,
      ipAddress: currentSession.ipAddress ?? undefined,
      userAgent: currentSession.userAgent ?? undefined,
      expiresAt: this.addSeconds(now, this.refreshTokenTtlSeconds),
      lastUsedAt: now,
    };
    const result = await this.repository.rotateSession(
      currentSession.id,
      nextSession,
      now,
    );
    if (!result) {
      await this.repository.revokeSessionFamily(
        currentSession.familyId,
        now,
        'REUSE_DETECTED',
      );
      throw new ApiException(
        HttpStatus.UNAUTHORIZED,
        'AUTH_REFRESH_TOKEN_REUSED',
        'This refresh token was already used. Sign in again.',
      );
    }

    return this.buildAuthResponse(
      result.user,
      result.session,
      nextRefreshToken.token,
    );
  }

  async logout(refreshTokenValue: string): Promise<void> {
    const parsed = this.refreshTokenService.parse(refreshTokenValue);
    if (!parsed) return;

    const session = await this.repository.getSession(parsed.sessionId);
    if (
      !session ||
      !this.refreshTokenService.matches(session.tokenDigest, parsed.digest)
    ) {
      return;
    }

    await this.repository.revokeSessionFamily(
      session.familyId,
      this.clock.now(),
      'LOGOUT',
    );
  }

  private async issueOtp(
    phoneNumber: string,
    now: Date,
    attemptsRemaining: number,
  ): Promise<OtpChallengeResponseDto> {
    const id = randomUUID();
    const code = this.otpCodeService.generate();
    const expiresAt = this.addSeconds(now, this.otpTtlSeconds);
    const resendAvailableAt = this.addSeconds(now, this.otpResendSeconds);
    const replacement = await this.repository.replaceActiveOtpChallenge(
      {
        id,
        phoneNumber,
        codeDigest: this.otpCodeService.digest(id, phoneNumber, code),
        expiresAt,
        resendAvailableAt,
        attemptsRemaining,
        lastSentAt: now,
      },
      now,
    );
    if (replacement.status === 'cooldown') {
      throw this.otpCooldownException(replacement.retryAfterSeconds);
    }
    const challenge = replacement.challenge;

    try {
      await this.otpDeliveryProvider.send({ phoneNumber, code, expiresAt });
    } catch {
      await this.repository.invalidateOtpChallenge(challenge.id, now);
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'AUTH_OTP_DELIVERY_FAILED',
        'We could not send a verification code. Try again shortly.',
      );
    }

    return {
      challengeId: challenge.id,
      phoneNumberMasked: this.phoneNumberService.mask(phoneNumber),
      expiresInSeconds: this.otpTtlSeconds,
      resendInSeconds: this.otpResendSeconds,
      codeLength: this.otpCodeService.length,
    };
  }

  private assertCanResend(
    challenge: OtpChallengeRecord | null,
    now: Date,
  ): void {
    if (
      challenge &&
      !challenge.consumedAt &&
      challenge.resendAvailableAt.getTime() > now.getTime()
    ) {
      const retryAfterSeconds = Math.ceil(
        (challenge.resendAvailableAt.getTime() - now.getTime()) / 1000,
      );
      throw this.otpCooldownException(retryAfterSeconds);
    }
  }

  private async getAvailableOtpAttempts(
    phoneNumber: string,
    now: Date,
  ): Promise<number> {
    const budget = await this.repository.getOtpAttemptBudget(phoneNumber);
    if (!budget) return this.otpMaxAttempts;

    if (budget.lockedUntil && budget.lockedUntil.getTime() <= now.getTime()) {
      await this.repository.resetOtpAttemptBudget(phoneNumber);
      return this.otpMaxAttempts;
    }

    if (
      budget.failedAttempts >= this.otpMaxAttempts ||
      (budget.lockedUntil && budget.lockedUntil.getTime() > now.getTime())
    ) {
      const retryAfterSeconds = budget.lockedUntil
        ? Math.max(
            1,
            Math.ceil((budget.lockedUntil.getTime() - now.getTime()) / 1000),
          )
        : this.otpLockSeconds;
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'AUTH_OTP_ATTEMPTS_EXCEEDED',
        'Too many invalid attempts. Try again later.',
        { retryAfterSeconds },
      );
    }

    return Math.max(0, this.otpMaxAttempts - budget.failedAttempts);
  }

  private assertChallengeCanBeVerified(
    challenge: OtpChallengeRecord | null,
    now: Date,
  ): asserts challenge is OtpChallengeRecord {
    if (!challenge || challenge.consumedAt) {
      throw this.invalidChallengeException();
    }
    if (challenge.attemptsRemaining <= 0) {
      throw new ApiException(
        HttpStatus.TOO_MANY_REQUESTS,
        'AUTH_OTP_ATTEMPTS_EXCEEDED',
        'Too many invalid attempts. Request a new code.',
      );
    }
    if (challenge.expiresAt.getTime() <= now.getTime()) {
      throw new ApiException(
        HttpStatus.GONE,
        'AUTH_OTP_EXPIRED',
        'The verification code has expired. Request a new code.',
      );
    }
  }

  private async buildAuthResponse(
    user: AuthUserRecord,
    session: AuthSessionRecord,
    refreshToken: string,
  ): Promise<AuthResponseDto> {
    const accessToken = await this.accessTokenService.issue(user, session.id);
    return {
      accessToken: accessToken.token,
      accessTokenExpiresInSeconds: accessToken.expiresInSeconds,
      refreshToken,
      refreshTokenExpiresInSeconds: this.refreshTokenTtlSeconds,
      user: this.toUserResponse(user),
    };
  }

  private toUserResponse(user: AuthUserRecord): UserResponseDto {
    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileComplete: user.profileCompletedAt !== null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private mapPlatform(
    platform: DevicePlatformInput | undefined,
  ): AuthDevicePlatform {
    if (platform === DevicePlatformInput.IOS) return 'IOS';
    if (platform === DevicePlatformInput.ANDROID) return 'ANDROID';
    if (platform === DevicePlatformInput.WEB) return 'WEB';
    return 'UNKNOWN';
  }

  private cleanOptional(
    value: string | undefined,
    maxLength: number,
  ): string | undefined {
    const cleaned = value?.trim().slice(0, maxLength);
    return cleaned ? cleaned : undefined;
  }

  private addSeconds(value: Date, seconds: number): Date {
    return new Date(value.getTime() + seconds * 1000);
  }

  private invalidChallengeException(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'AUTH_OTP_CHALLENGE_INVALID',
      'The verification challenge is invalid. Request a new code.',
    );
  }

  private otpCooldownException(retryAfterSeconds: number): ApiException {
    return new ApiException(
      HttpStatus.TOO_MANY_REQUESTS,
      'AUTH_OTP_COOLDOWN',
      'Wait before requesting another verification code.',
      { retryAfterSeconds },
    );
  }

  private invalidRefreshTokenException(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'AUTH_REFRESH_TOKEN_INVALID',
      'The refresh token is invalid. Sign in again.',
    );
  }
}

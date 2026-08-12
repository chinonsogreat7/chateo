import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { AuthController } from './auth.controller';
import { AuthRepository } from './auth.repository';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaAuthRepository } from './prisma-auth.repository';
import { AccessTokenService } from './providers/access-token.service';
import { Clock, SystemClock } from './providers/clock';
import { OtpCodeService } from './providers/otp-code.service';
import {
  ConsoleOtpDeliveryProvider,
  OtpDeliveryProvider,
  TwilioOtpDeliveryProvider,
} from './providers/otp-delivery.provider';
import { PhoneNumberService } from './providers/phone-number.service';
import { RefreshTokenService } from './providers/refresh-token.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          audience: 'chateo-mobile',
          expiresIn: config.get<number>('AUTH_ACCESS_TOKEN_TTL_SECONDS', 900),
          issuer: 'chateo-api',
        },
        verifyOptions: {
          audience: 'chateo-mobile',
          issuer: 'chateo-api',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PrismaAuthRepository,
    { provide: AuthRepository, useExisting: PrismaAuthRepository },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
    ConsoleOtpDeliveryProvider,
    TwilioOtpDeliveryProvider,
    {
      provide: OtpDeliveryProvider,
      inject: [
        ConfigService,
        ConsoleOtpDeliveryProvider,
        TwilioOtpDeliveryProvider,
      ],
      useFactory: (
        config: ConfigService,
        consoleProvider: ConsoleOtpDeliveryProvider,
        twilioProvider: TwilioOtpDeliveryProvider,
      ): OtpDeliveryProvider =>
        config.get<string>('OTP_PROVIDER', 'console') === 'twilio'
          ? twilioProvider
          : consoleProvider,
    },
    PhoneNumberService,
    OtpCodeService,
    RefreshTokenService,
    AccessTokenService,
    NoStoreInterceptor,
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
  ],
  exports: [AuthRepository, AuthService],
})
export class AuthModule {}

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PhoneNumberService } from './phone-number.service';

export interface DeliverOtpInput {
  phoneNumber: string;
  code: string;
  expiresAt: Date;
}

export abstract class OtpDeliveryProvider {
  abstract send(input: DeliverOtpInput): Promise<void>;
}

@Injectable()
export class ConsoleOtpDeliveryProvider extends OtpDeliveryProvider {
  private readonly logger = new Logger(ConsoleOtpDeliveryProvider.name);

  constructor(
    private readonly config: ConfigService,
    private readonly phoneNumberService: PhoneNumberService,
  ) {
    super();
  }

  send(input: DeliverOtpInput): Promise<void> {
    const environment = this.config.get<string>('NODE_ENV', 'development');
    if (environment === 'production') {
      return Promise.reject(
        new Error('The console OTP provider cannot deliver production codes.'),
      );
    }

    this.logger.warn(
      `Development OTP ${input.code} for ${this.phoneNumberService.mask(input.phoneNumber)} expires at ${input.expiresAt.toISOString()}`,
    );
    return Promise.resolve();
  }
}

@Injectable()
export class TwilioOtpDeliveryProvider extends OtpDeliveryProvider {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(input: DeliverOtpInput): Promise<void> {
    const accountSid = this.config.getOrThrow<string>('TWILIO_ACCOUNT_SID');
    const apiKey = this.config.getOrThrow<string>('TWILIO_API_KEY');
    const apiSecret = this.config.getOrThrow<string>('TWILIO_API_SECRET');
    const fromNumber = this.config.getOrThrow<string>('TWILIO_FROM_NUMBER');
    const minutesRemaining = Math.max(
      1,
      Math.ceil((input.expiresAt.getTime() - Date.now()) / 60_000),
    );
    const body = new URLSearchParams({
      To: input.phoneNumber,
      From: fromNumber,
      Body: `Your ChatMe verification code is ${input.code}. It expires in ${minutesRemaining} minutes.`,
    });
    const credentials = Buffer.from(`${apiKey}:${apiSecret}`).toString(
      'base64',
    );
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(10_000),
      },
    );

    await response.body?.cancel();
    if (!response.ok) {
      throw new Error(
        `Twilio OTP delivery failed with HTTP ${response.status}`,
      );
    }
  }
}

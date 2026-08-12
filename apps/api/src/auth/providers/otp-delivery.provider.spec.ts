import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConsoleOtpDeliveryProvider,
  TwilioOtpDeliveryProvider,
} from './otp-delivery.provider';
import { PhoneNumberService } from './phone-number.service';

const otpInput = {
  phoneNumber: '+2348012345678',
  code: '123456',
  expiresAt: new Date('2026-08-09T12:05:00.000Z'),
};

describe('ConsoleOtpDeliveryProvider', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(['development', 'test'])(
    'delivers through the logger in %s',
    async (nodeEnvironment) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const provider = new ConsoleOtpDeliveryProvider(
        new ConfigService({ NODE_ENV: nodeEnvironment }),
        new PhoneNumberService(),
      );

      await expect(provider.send(otpInput)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Development OTP 123456 for +234********78'),
      );
    },
  );

  it('refuses to deliver a code in production', async () => {
    const provider = new ConsoleOtpDeliveryProvider(
      new ConfigService({ NODE_ENV: 'production' }),
      new PhoneNumberService(),
    );

    await expect(provider.send(otpInput)).rejects.toThrow(
      'console OTP provider cannot deliver production codes',
    );
  });
});

describe('TwilioOtpDeliveryProvider', () => {
  const accountSid = `AC${'a'.repeat(32)}`;
  const apiKey = `SK${'b'.repeat(32)}`;
  const apiSecret = 'twilio-api-secret-at-least-16-characters';
  const fromNumber = '+15551234567';

  beforeEach(() => {
    jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-08-09T12:00:00.000Z').getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createProvider(): TwilioOtpDeliveryProvider {
    return new TwilioOtpDeliveryProvider(
      new ConfigService({
        TWILIO_ACCOUNT_SID: accountSid,
        TWILIO_API_KEY: apiKey,
        TWILIO_API_SECRET: apiSecret,
        TWILIO_FROM_NUMBER: fromNumber,
      }),
    );
  }

  it('posts a form-encoded message with Basic API-key credentials', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 201 } as Response);

    await createProvider().send(otpInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    );
    expect(init).toMatchObject({
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const form = init?.body;
    expect(form).toBeInstanceOf(URLSearchParams);
    expect((form as URLSearchParams).get('To')).toBe(otpInput.phoneNumber);
    expect((form as URLSearchParams).get('From')).toBe(fromNumber);
    expect((form as URLSearchParams).get('Body')).toBe(
      'Your ChatMe verification code is 123456. It expires in 5 minutes.',
    );
  });

  it('throws a status-only error for a non-success response', async () => {
    const responseText = jest.fn().mockResolvedValue('private Twilio response');
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      text: responseText,
    } as unknown as Response);

    const send = createProvider().send(otpInput);

    await expect(send).rejects.toThrow(
      'Twilio OTP delivery failed with HTTP 401',
    );
    await expect(send).rejects.not.toThrow('private Twilio response');
    expect(responseText).not.toHaveBeenCalled();
  });
});

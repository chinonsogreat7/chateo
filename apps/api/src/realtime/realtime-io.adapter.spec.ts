import { ConfigService } from '@nestjs/config';
import type { IncomingMessage } from 'node:http';
import {
  configuredRealtimeAllowRequest,
  configuredRealtimeCorsOrigin,
} from './realtime-io.adapter';

describe('configuredRealtimeCorsOrigin', () => {
  it('allows development origins for local student clients', () => {
    expect(
      configuredRealtimeCorsOrigin(
        new ConfigService({ NODE_ENV: 'development', CORS_ORIGINS: '' }),
      ),
    ).toBe(true);
  });

  it('uses only the production allowlist and denies an empty allowlist', () => {
    expect(
      configuredRealtimeCorsOrigin(
        new ConfigService({
          NODE_ENV: 'production',
          CORS_ORIGINS: 'https://app.example.com, https://student.example.com ',
        }),
      ),
    ).toEqual(['https://app.example.com', 'https://student.example.com']);
    expect(
      configuredRealtimeCorsOrigin(
        new ConfigService({ NODE_ENV: 'production', CORS_ORIGINS: '' }),
      ),
    ).toBe(false);
  });
});

describe('configuredRealtimeAllowRequest', () => {
  function isAllowed(config: ConfigService, origin?: string): Promise<boolean> {
    const allowRequest = configuredRealtimeAllowRequest(config);
    return new Promise((resolve, reject) => {
      allowRequest(
        { headers: origin === undefined ? {} : { origin } } as IncomingMessage,
        (error, allowed) => {
          if (error) reject(new Error(error));
          else resolve(allowed);
        },
      );
    });
  }

  it('enforces the production origin allowlist on websocket upgrades', async () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      CORS_ORIGINS: 'https://app.example.com',
    });

    await expect(isAllowed(config, 'https://app.example.com')).resolves.toBe(
      true,
    );
    await expect(isAllowed(config, 'https://evil.example.com')).resolves.toBe(
      false,
    );
  });

  it('allows origin-less native clients but rejects browser origins when production has no allowlist', async () => {
    const config = new ConfigService({
      NODE_ENV: 'production',
      CORS_ORIGINS: '',
    });

    await expect(isAllowed(config)).resolves.toBe(true);
    await expect(isAllowed(config, 'https://app.example.com')).resolves.toBe(
      false,
    );
  });
});

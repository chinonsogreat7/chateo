import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PushDelivery } from './push.repository';

export type PushResult =
  | { status: 'accepted'; ticketId: string }
  | { status: 'ok' | 'pending' }
  | { status: 'error'; code: string; retryable: boolean };
export abstract class PushProvider {
  abstract send(
    delivery: PushDelivery,
    notificationId: string,
  ): Promise<PushResult>;
  abstract receipt(ticketId: string): Promise<PushResult>;
}

@Injectable()
export class ExpoPushProvider extends PushProvider {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async send(
    delivery: PushDelivery,
    notificationId: string,
  ): Promise<PushResult> {
    const response = await this.request('send', [
      {
        to: delivery.token,
        title: 'ChatMe',
        body: 'You have a new message.',
        sound: 'default',
        ttl: 3600,
        collapseId: notificationId,
        tag: notificationId,
        data: {
          type: 'message',
          conversationId: delivery.conversationId,
          messageId: delivery.messageId,
          notificationId,
        },
      },
    ]);
    if ('status' in response) return response;
    const ticket: unknown = Array.isArray(response.data)
      ? response.data[0]
      : null;
    if (
      object(ticket) &&
      ticket.status === 'ok' &&
      typeof ticket.id === 'string' &&
      ticket.id.length <= 255 &&
      ticket.id.length > 0
    )
      return { status: 'accepted', ticketId: ticket.id };
    return this.parseError(ticket);
  }

  async receipt(ticketId: string): Promise<PushResult> {
    const response = await this.request('getReceipts', { ids: [ticketId] });
    if ('status' in response) return response;
    if (!object(response.data))
      return { status: 'error', code: 'MalformedResponse', retryable: true };
    const receipt: unknown = response.data[ticketId];
    if (receipt === undefined) return { status: 'pending' };
    if (object(receipt) && receipt.status === 'ok') return { status: 'ok' };
    return this.parseError(receipt);
  }

  private async request(
    path: 'send' | 'getReceipts',
    payload: unknown,
  ): Promise<{ data: unknown } | Extract<PushResult, { status: 'error' }>> {
    if (!this.config.get<boolean>('PUSH_NOTIFICATIONS_ENABLED', false))
      return { status: 'error', code: 'Disabled', retryable: false };
    try {
      const response = await fetch(`https://exp.host/--/api/v2/push/${path}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.getOrThrow<string>('EXPO_ACCESS_TOKEN')}`,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok)
        return {
          status: 'error',
          code: `HTTP_${response.status}`,
          retryable:
            response.status === 429 ||
            response.status === 408 ||
            response.status >= 500,
        };
      const value: unknown = await response.json();
      if (!object(value) || value.errors || !('data' in value))
        return { status: 'error', code: 'MalformedResponse', retryable: true };
      return { data: value.data };
    } catch {
      return { status: 'error', code: 'TransportError', retryable: true };
    }
  }

  private parseError(value: unknown): Extract<PushResult, { status: 'error' }> {
    const reported =
      object(value) && object(value.details) ? value.details.error : null;
    const known = [
      'DeviceNotRegistered',
      'MessageTooBig',
      'MessageRateExceeded',
      'MismatchSenderId',
      'InvalidCredentials',
    ];
    const code =
      typeof reported === 'string' && known.includes(reported)
        ? reported
        : 'ProviderError';
    return {
      status: 'error',
      code,
      retryable: code === 'MessageRateExceeded' || code === 'ProviderError',
    };
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

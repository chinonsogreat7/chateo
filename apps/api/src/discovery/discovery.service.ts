import { HttpStatus, Injectable } from '@nestjs/common';
import { PhoneNumberService } from '../auth/providers/phone-number.service';
import { ApiException } from '../common/errors/api.exception';
import { DiscoveryRepository } from './discovery.repository';
import type {
  ContactMatchesResponseDto,
  PublicDiscoveryUserDto,
  UserSearchResponseDto,
} from './dto/discovery-response.dto';
import type { SearchUsersQueryDto } from './dto/search-users-query.dto';
import type {
  DiscoveryCursorBoundary,
  PublicDiscoveryUserRecord,
} from './discovery.types';

const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DiscoveryCursorPayload {
  v: 1;
  q: string;
  createdAt: string;
  id: string;
}

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly repository: DiscoveryRepository,
    private readonly phoneNumbers: PhoneNumberService,
  ) {}

  async matchContacts(
    currentUserId: string,
    values: readonly unknown[],
  ): Promise<ContactMatchesResponseDto> {
    const normalizedPhoneNumbers: string[] = [];
    const seenPhoneNumbers = new Set<string>();
    const invalidIndices: number[] = [];

    values.forEach((value, index) => {
      const normalized = this.normalizePhoneNumber(value);
      if (!normalized) {
        invalidIndices.push(index);
        return;
      }
      if (!seenPhoneNumbers.has(normalized)) {
        seenPhoneNumbers.add(normalized);
        normalizedPhoneNumbers.push(normalized);
      }
    });

    if (invalidIndices.length > 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONTACTS_INVALID_PHONE_NUMBER',
        'One or more phone numbers are not valid E.164 numbers.',
        { invalidIndices },
      );
    }

    const records = await this.repository.matchContacts({
      currentUserId,
      phoneNumbers: normalizedPhoneNumbers,
    });
    const recordsByPhoneNumber = new Map(
      records.map((record) => [record.phoneNumber, record]),
    );

    return {
      matches: normalizedPhoneNumbers.flatMap((matchedPhoneNumber) => {
        const record = recordsByPhoneNumber.get(matchedPhoneNumber);
        return record
          ? [
              {
                matchedPhoneNumber,
                user: this.toPublicUser(record),
              },
            ]
          : [];
      }),
    };
  }

  async searchUsers(
    currentUserId: string,
    input: SearchUsersQueryDto,
  ): Promise<UserSearchResponseDto> {
    const normalizedQuery = this.normalizeSearchQuery(input.q);
    const after =
      input.cursor !== undefined
        ? this.decodeCursor(input.cursor, normalizedQuery)
        : undefined;
    const records = await this.repository.searchUsers({
      currentUserId,
      normalizedQuery,
      databaseQuery: this.escapeLikePattern(normalizedQuery),
      take: input.limit + 1,
      ...(after ? { after } : {}),
    });
    const hasNextPage = records.length > input.limit;
    const page = records.slice(0, input.limit);
    const lastRecord = page.at(-1);

    return {
      items: page.map((record) => this.toPublicUser(record)),
      nextCursor:
        hasNextPage && lastRecord
          ? this.encodeCursor(normalizedQuery, lastRecord)
          : null,
    };
  }

  private normalizePhoneNumber(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    const candidate = value.trim();
    if (candidate.length === 0 || candidate.length > 32) return null;

    try {
      return this.phoneNumbers.normalize(candidate);
    } catch {
      return null;
    }
  }

  private normalizeSearchQuery(value: string): string {
    return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
  }

  private escapeLikePattern(value: string): string {
    return value.replace(/[\\%_]/g, '\\$&');
  }

  private encodeCursor(
    normalizedQuery: string,
    record: PublicDiscoveryUserRecord,
  ): string {
    const payload: DiscoveryCursorPayload = {
      v: 1,
      q: normalizedQuery,
      createdAt: record.createdAt.toISOString(),
      id: record.id,
    };
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  private decodeCursor(
    cursor: string,
    normalizedQuery: string,
  ): DiscoveryCursorBoundary {
    try {
      if (!CURSOR_PATTERN.test(cursor)) throw new Error('Invalid encoding');

      const value: unknown = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      );
      if (!this.isCursorPayload(value) || value.q !== normalizedQuery) {
        throw new Error('Invalid payload');
      }

      const createdAt = new Date(value.createdAt);
      if (
        Number.isNaN(createdAt.getTime()) ||
        createdAt.toISOString() !== value.createdAt
      ) {
        throw new Error('Invalid date');
      }

      return { createdAt, id: value.id };
    } catch {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'DISCOVERY_INVALID_CURSOR',
        'The pagination cursor is invalid for this search.',
      );
    }
  }

  private isCursorPayload(value: unknown): value is DiscoveryCursorPayload {
    if (typeof value !== 'object' || value === null) return false;
    const payload = value as Record<string, unknown>;
    return (
      payload.v === 1 &&
      typeof payload.q === 'string' &&
      typeof payload.createdAt === 'string' &&
      typeof payload.id === 'string' &&
      UUID_PATTERN.test(payload.id)
    );
  }

  private toPublicUser(
    record: PublicDiscoveryUserRecord,
  ): PublicDiscoveryUserDto {
    return {
      id: record.id,
      displayName: record.displayName,
      avatarUrl: record.avatarUrl,
    };
  }
}

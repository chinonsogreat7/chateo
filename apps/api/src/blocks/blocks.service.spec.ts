import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { BlocksRepository } from './blocks.repository';
import { BlocksService } from './blocks.service';
import type { UserBlockRecord } from './blocks.types';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ID = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-09-03T10:00:00.000Z');

function blockRecord(
  overrides: Partial<UserBlockRecord> = {},
): UserBlockRecord {
  return {
    user: {
      id: TARGET_ID,
      displayName: 'Ada Okafor',
      avatarUrl: 'https://example.com/ada.jpg',
    },
    blockedAt: NOW,
    ...overrides,
  };
}

function createService() {
  const repository: jest.Mocked<BlocksRepository> = {
    listForUser: jest.fn(),
    block: jest.fn(),
    unblock: jest.fn(),
    hasBlockBetween: jest.fn(),
  };
  return {
    repository,
    service: new BlocksService(repository),
  };
}

async function expectApiError(
  promise: Promise<unknown>,
  status: HttpStatus,
  code: string,
): Promise<void> {
  const error = await promise.then(
    () => {
      throw new Error(`Expected ${code}, but the operation resolved.`);
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiException);
  expect((error as ApiException).getStatus()).toBe(status);
  expect((error as ApiException).getResponse()).toMatchObject({ code });
}

describe('BlocksService', () => {
  it('lists only public blocked-user fields and the block timestamp', async () => {
    const { repository, service } = createService();
    repository.listForUser.mockResolvedValue([blockRecord()]);

    const result = await service.list(USER_ID.toUpperCase());

    expect(repository.listForUser).toHaveBeenCalledWith(USER_ID);
    expect(result).toEqual({
      items: [
        {
          user: {
            id: TARGET_ID,
            displayName: 'Ada Okafor',
            avatarUrl: 'https://example.com/ada.jpg',
          },
          blockedAt: NOW.toISOString(),
        },
      ],
    });
    expect(result.items[0]?.user).not.toHaveProperty('phoneNumber');
  });

  it('rejects blocking yourself case-insensitively before querying', async () => {
    const { repository, service } = createService();

    await expectApiError(
      service.block(USER_ID, USER_ID.toUpperCase()),
      HttpStatus.BAD_REQUEST,
      'USER_BLOCK_SELF_NOT_ALLOWED',
    );

    expect(repository.block).not.toHaveBeenCalled();
  });

  it('returns USER_NOT_FOUND when the selected user is missing', async () => {
    const { repository, service } = createService();
    repository.block.mockResolvedValue({ status: 'user-not-found' });

    await expectApiError(
      service.block(USER_ID, TARGET_ID),
      HttpStatus.NOT_FOUND,
      'USER_NOT_FOUND',
    );
  });

  it('maps an idempotent block result without exposing private fields', async () => {
    const { repository, service } = createService();
    repository.block.mockResolvedValue({
      status: 'blocked',
      block: blockRecord(),
    });

    await expect(
      service.block(USER_ID.toUpperCase(), TARGET_ID.toUpperCase()),
    ).resolves.toEqual({
      user: {
        id: TARGET_ID,
        displayName: 'Ada Okafor',
        avatarUrl: 'https://example.com/ada.jpg',
      },
      blockedAt: NOW.toISOString(),
    });
    expect(repository.block).toHaveBeenCalledWith(USER_ID, TARGET_ID);
  });

  it('unblocks idempotently without requiring the target to exist', async () => {
    const { repository, service } = createService();
    repository.unblock.mockResolvedValue(undefined);

    await expect(
      service.unblock(USER_ID.toUpperCase(), TARGET_ID.toUpperCase()),
    ).resolves.toBeUndefined();
    expect(repository.unblock).toHaveBeenCalledWith(USER_ID, TARGET_ID);
  });
});

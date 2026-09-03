import type { BlockUserResult, UserBlockRecord } from './blocks.types';

export abstract class BlocksRepository {
  abstract listForUser(blockerId: string): Promise<UserBlockRecord[]>;

  abstract block(
    blockerId: string,
    blockedId: string,
  ): Promise<BlockUserResult>;

  abstract unblock(blockerId: string, blockedId: string): Promise<void>;

  abstract hasBlockBetween(
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean>;
}

import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { BlocksRepository } from './blocks.repository';
import type {
  BlockListResponseDto,
  BlockResponseDto,
} from './dto/block-response.dto';
import type { UserBlockRecord } from './blocks.types';

@Injectable()
export class BlocksService {
  constructor(private readonly repository: BlocksRepository) {}

  async list(userId: string): Promise<BlockListResponseDto> {
    const records = await this.repository.listForUser(userId.toLowerCase());
    return { items: records.map((record) => this.toResponse(record)) };
  }

  async block(userId: string, targetUserId: string): Promise<BlockResponseDto> {
    const normalizedUserId = userId.toLowerCase();
    const normalizedTargetUserId = targetUserId.toLowerCase();
    if (normalizedUserId === normalizedTargetUserId) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'USER_BLOCK_SELF_NOT_ALLOWED',
        'You cannot block yourself.',
      );
    }

    const result = await this.repository.block(
      normalizedUserId,
      normalizedTargetUserId,
    );
    if (result.status === 'user-not-found') {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'USER_NOT_FOUND',
        'The selected user does not exist.',
      );
    }

    return this.toResponse(result.block);
  }

  async unblock(userId: string, targetUserId: string): Promise<void> {
    await this.repository.unblock(
      userId.toLowerCase(),
      targetUserId.toLowerCase(),
    );
  }

  private toResponse(record: UserBlockRecord): BlockResponseDto {
    return {
      user: {
        id: record.user.id,
        displayName: record.user.displayName,
        avatarUrl: record.user.avatarUrl,
      },
      blockedAt: record.blockedAt.toISOString(),
    };
  }
}

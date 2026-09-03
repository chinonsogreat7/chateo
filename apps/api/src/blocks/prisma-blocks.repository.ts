import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { BlocksRepository } from './blocks.repository';
import type { BlockUserResult, UserBlockRecord } from './blocks.types';

const blockedPublicUserSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
} satisfies Prisma.UserSelect;

const userBlockSelect = {
  createdAt: true,
  blocked: { select: blockedPublicUserSelect },
} satisfies Prisma.UserBlockSelect;

@Injectable()
export class PrismaBlocksRepository extends BlocksRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async listForUser(blockerId: string): Promise<UserBlockRecord[]> {
    const blocks = await this.prisma.userBlock.findMany({
      where: { blockerId },
      select: userBlockSelect,
      orderBy: [{ createdAt: 'desc' }, { blockedId: 'asc' }],
    });

    return blocks.map((block) => ({
      user: block.blocked,
      blockedAt: block.createdAt,
    }));
  }

  async block(blockerId: string, blockedId: string): Promise<BlockUserResult> {
    const blocked = await this.prisma.user.findUnique({
      where: { id: blockedId },
      select: blockedPublicUserSelect,
    });
    if (!blocked) return { status: 'user-not-found' };

    try {
      const persisted = await this.prisma.userBlock.upsert({
        where: {
          blockerId_blockedId: { blockerId, blockedId },
        },
        create: { blockerId, blockedId },
        update: {},
        select: { createdAt: true },
      });

      return {
        status: 'blocked',
        block: { user: blocked, blockedAt: persisted.createdAt },
      };
    } catch (error) {
      // A target can be deleted after the lookup but before the upsert. Treat
      // that foreign-key race exactly like an initially missing target.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2003'
      ) {
        return { status: 'user-not-found' };
      }
      throw error;
    }
  }

  async unblock(blockerId: string, blockedId: string): Promise<void> {
    await this.prisma.userBlock.deleteMany({
      where: { blockerId, blockedId },
    });
  }

  async hasBlockBetween(
    firstUserId: string,
    secondUserId: string,
  ): Promise<boolean> {
    const block = await this.prisma.userBlock.findFirst({
      where: {
        OR: [
          { blockerId: firstUserId, blockedId: secondUserId },
          { blockerId: secondUserId, blockedId: firstUserId },
        ],
      },
      select: { blockerId: true },
    });

    return block !== null;
  }
}

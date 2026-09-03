import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { DiscoveryRepository } from './discovery.repository';
import type {
  ContactMatchRecord,
  MatchContactsRepositoryInput,
  PublicDiscoveryUserRecord,
  SearchUsersRepositoryInput,
} from './discovery.types';

const publicUserSelect = {
  id: true,
  displayName: true,
  avatarUrl: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

@Injectable()
export class PrismaDiscoveryRepository extends DiscoveryRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async matchContacts(
    input: MatchContactsRepositoryInput,
  ): Promise<ContactMatchRecord[]> {
    if (input.phoneNumbers.length === 0) return [];

    return this.prisma.user.findMany({
      where: {
        id: { not: input.currentUserId },
        phoneNumber: { in: [...input.phoneNumbers] },
        blocksInitiated: { none: { blockedId: input.currentUserId } },
        blocksReceived: { none: { blockerId: input.currentUserId } },
      },
      select: {
        ...publicUserSelect,
        phoneNumber: true,
      },
    });
  }

  searchUsers(
    input: SearchUsersRepositoryInput,
  ): Promise<PublicDiscoveryUserRecord[]> {
    const keysetFilter: Prisma.UserWhereInput | undefined = input.after
      ? {
          OR: [
            { createdAt: { lt: input.after.createdAt } },
            {
              createdAt: input.after.createdAt,
              id: { lt: input.after.id },
            },
          ],
        }
      : undefined;

    return this.prisma.user.findMany({
      where: {
        id: { not: input.currentUserId },
        profileCompletedAt: { not: null },
        blocksInitiated: { none: { blockedId: input.currentUserId } },
        blocksReceived: { none: { blockerId: input.currentUserId } },
        displayName: {
          not: null,
          contains: input.databaseQuery,
          mode: Prisma.QueryMode.insensitive,
        },
        ...(keysetFilter ?? {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.take,
      select: publicUserSelect,
    });
  }
}

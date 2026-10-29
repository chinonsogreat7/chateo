import type { Prisma } from '@prisma/client';

/** Use the same boundary for history, galleries, links and private bookmarks. */
export function visibleHistoryWhere(membership: {
  clearedAt: Date | null;
  clearedThroughMessageId: string | null;
}): Prisma.MessageWhereInput {
  return membership.clearedAt && membership.clearedThroughMessageId
    ? {
        OR: [
          { createdAt: { gt: membership.clearedAt } },
          {
            createdAt: membership.clearedAt,
            id: { gt: membership.clearedThroughMessageId },
          },
        ],
      }
    : {};
}

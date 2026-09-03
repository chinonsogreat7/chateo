import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface RealtimeConversationAccess {
  conversationId: string;
  participantIds: string[];
}

export abstract class RealtimeConversationsRepository {
  abstract findAccessibleConversation(
    conversationId: string,
    userId: string,
  ): Promise<RealtimeConversationAccess | null>;
}

@Injectable()
export class PrismaRealtimeConversationsRepository extends RealtimeConversationsRepository {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async findAccessibleConversation(
    conversationId: string,
    userId: string,
  ): Promise<RealtimeConversationAccess | null> {
    const conversation = await this.prisma.conversation.findFirst({
      where: {
        id: conversationId.toLowerCase(),
        members: { some: { userId: userId.toLowerCase() } },
      },
      select: {
        id: true,
        type: true,
        members: {
          select: { userId: true },
          orderBy: { userId: 'asc' },
        },
      },
    });

    if (!conversation) return null;
    const normalizedUserId = userId.toLowerCase();
    if (conversation.type === 'DIRECT') {
      const otherUserId = conversation.members.find(
        (member) => member.userId !== normalizedUserId,
      )?.userId;
      if (!otherUserId) return null;

      const block = await this.prisma.userBlock.findFirst({
        where: {
          OR: [
            { blockerId: normalizedUserId, blockedId: otherUserId },
            { blockerId: otherUserId, blockedId: normalizedUserId },
          ],
        },
        select: { blockerId: true },
      });
      if (block) return null;
    }
    return {
      conversationId: conversation.id,
      participantIds: conversation.members.map((member) => member.userId),
    };
  }
}

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
        members: {
          select: { userId: true },
          orderBy: { userId: 'asc' },
        },
      },
    });

    if (!conversation) return null;
    return {
      conversationId: conversation.id,
      participantIds: conversation.members.map((member) => member.userId),
    };
  }
}

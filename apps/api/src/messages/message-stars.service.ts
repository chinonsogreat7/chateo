import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../common/errors/api.exception';
import { PrismaService } from '../database/prisma.service';
import { visibleHistoryWhere } from './message-visibility';
import type { MessageStarResponseDto } from './dto/message-collections.dto';

@Injectable()
export class MessageStarsService {
  constructor(private readonly prisma: PrismaService) {}

  get(
    userId: string,
    conversationId: string,
    messageId: string,
  ): Promise<MessageStarResponseDto> {
    return this.access(userId, conversationId, messageId);
  }

  set(
    userId: string,
    conversationId: string,
    messageId: string,
    starred: boolean,
  ): Promise<MessageStarResponseDto> {
    return this.access(userId, conversationId, messageId, starred);
  }

  private async access(
    userId: string,
    conversationId: string,
    messageId: string,
    starred?: boolean,
  ): Promise<MessageStarResponseDto> {
    userId = userId.toLowerCase();
    conversationId = conversationId.toLowerCase();
    messageId = messageId.toLowerCase();
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            const member = await tx.conversationMember.findUnique({
              where: { conversationId_userId: { conversationId, userId } },
              select: { clearedAt: true, clearedThroughMessageId: true },
            });
            const message =
              member &&
              (await tx.message.findFirst({
                where: {
                  id: messageId,
                  conversationId,
                  deletedAt: null,
                  ...visibleHistoryWhere(member),
                },
                select: { id: true },
              }));
            if (!message)
              throw new ApiException(
                HttpStatus.NOT_FOUND,
                'MESSAGE_NOT_FOUND',
                'The message was not found.',
              );
            // Stars are private metadata, never broadcast to other participants.
            // Like history reads, a block does not erase previously visible messages.
            if (starred === false)
              await tx.messageStar.deleteMany({ where: { messageId, userId } });
            const star =
              starred === true
                ? await tx.messageStar.upsert({
                    where: { messageId_userId: { messageId, userId } },
                    create: { messageId, userId },
                    update: {},
                  })
                : await tx.messageStar.findUnique({
                    where: { messageId_userId: { messageId, userId } },
                  });
            return {
              conversationId,
              messageId,
              starred: star !== null,
              starredAt: star?.starredAt.toISOString() ?? null,
            };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          attempt >= 2 ||
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          !['P2034', 'P2002'].includes(error.code)
        )
          throw error;
      }
    }
  }
}

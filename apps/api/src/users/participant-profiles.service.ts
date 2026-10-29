import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ApiException } from '../common/errors/api.exception';
import { PrismaService } from '../database/prisma.service';
import type { ParticipantProfileResponseDto } from './dto/participant-profile.dto';

@Injectable()
export class ParticipantProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(
    viewerId: string,
    conversationId: string,
    participantId: string,
  ): Promise<ParticipantProfileResponseDto> {
    viewerId = viewerId.toLowerCase();
    conversationId = conversationId.toLowerCase();
    participantId = participantId.toLowerCase();
    return this.prisma.$transaction(
      async (tx) => {
        const viewer = await tx.conversationMember.findUnique({
          where: {
            conversationId_userId: { conversationId, userId: viewerId },
          },
          select: { userId: true },
        });
        if (!viewer) throw this.notFound();
        const blocked =
          viewerId !== participantId &&
          (await tx.userBlock.findFirst({
            where: {
              OR: [
                { blockerId: viewerId, blockedId: participantId },
                { blockerId: participantId, blockedId: viewerId },
              ],
            },
            select: { blockerId: true },
          }));
        if (blocked) throw this.notFound();
        const participant = await tx.conversationMember.findUnique({
          where: {
            conversationId_userId: { conversationId, userId: participantId },
          },
          select: {
            user: {
              select: {
                id: true,
                displayName: true,
                avatarUrl: true,
                bio: true,
                phoneNumber: true,
                sharePhoneNumber: true,
                lastSeenAt: true,
                shareLastSeen: true,
              },
            },
          },
        });
        if (!participant) throw this.notFound();
        const user = participant.user;
        const self = viewerId === participantId;
        return {
          id: user.id,
          displayName: user.displayName,
          avatarUrl: user.avatarUrl,
          bio: user.bio,
          phoneNumber: self || user.sharePhoneNumber ? user.phoneNumber : null,
          lastSeenAt:
            self || user.shareLastSeen
              ? (user.lastSeenAt?.toISOString() ?? null)
              : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  private notFound(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'PARTICIPANT_NOT_FOUND',
      'The participant profile is unavailable in this conversation.',
    );
  }
}

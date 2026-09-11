import type { Prisma } from '@prisma/client';
import { isMuted, PUSH_DEVICE_MAX_AGE_MS } from './push-policy';

// Called inside the SAME serializable transaction as the first message insert.
// Send replays never enter this path; provider calls never run in this transaction.
export async function enqueueMessagePush(
  tx: Prisma.TransactionClient,
  message: { id: string; conversationId: string; senderId: string },
  now: Date,
  delaySeconds: number,
): Promise<void> {
  const members = await tx.conversationMember.findMany({
    where: {
      conversationId: message.conversationId,
      userId: { not: message.senderId },
    },
    select: { userId: true, mutedAt: true, mutedUntil: true },
  });
  const recipients = members
    .filter((member) => !isMuted(member, now))
    .map((member) => member.userId);
  if (recipients.length === 0) return;
  const devices = await tx.pushDevice.findMany({
    where: {
      userId: { in: recipients },
      disabledAt: null,
      token: { not: null },
      registeredAt: { gt: new Date(now.getTime() - PUSH_DEVICE_MAX_AGE_MS) },
    },
    select: { id: true, userId: true, familyId: true, version: true },
  });
  if (devices.length === 0) return;
  const sessions = await tx.authSession.findMany({
    where: {
      OR: devices.map((device) => ({
        userId: device.userId,
        familyId: device.familyId,
      })),
      revokedAt: null,
      expiresAt: { gt: now },
    },
    select: { userId: true, familyId: true },
  });
  const active = new Set(
    sessions.map((session) => `${session.userId}:${session.familyId}`),
  );
  const data = devices
    .filter((device) => active.has(`${device.userId}:${device.familyId}`))
    .map((device) => ({
      messageId: message.id,
      deviceId: device.id,
      deviceVersion: device.version,
      createdAt: now,
      nextAttemptAt: new Date(now.getTime() + delaySeconds * 1000),
    }));
  if (data.length)
    await tx.pushNotification.createMany({ data, skipDuplicates: true });
}

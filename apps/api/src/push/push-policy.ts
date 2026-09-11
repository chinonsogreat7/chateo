export const PUSH_DEVICE_MAX_AGE_MS = 30 * 24 * 3600_000;
export const PUSH_JOB_MAX_AGE_MS = 24 * 3600_000;
export const PUSH_RECEIPT_DELAY_MS = 15 * 60_000;
export const PUSH_MAX_ATTEMPTS = 6;

export function isMuted(
  member: { mutedAt: Date | null; mutedUntil: Date | null },
  now: Date,
): boolean {
  return (
    member.mutedAt !== null &&
    (member.mutedUntil === null || member.mutedUntil > now)
  );
}

export function clearedMessage(
  member: { clearedAt: Date | null; clearedThroughMessageId: string | null },
  message: { id: string; createdAt: Date },
): boolean {
  return Boolean(
    member.clearedAt &&
      member.clearedThroughMessageId &&
      (message.createdAt < member.clearedAt ||
        (message.createdAt.getTime() === member.clearedAt.getTime() &&
          message.id <= member.clearedThroughMessageId)),
  );
}

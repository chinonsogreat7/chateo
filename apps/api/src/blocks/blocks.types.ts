export interface BlockedPublicUserRecord {
  id: string;
  displayName: string | null;
  avatarUrl: string | null;
}

export interface UserBlockRecord {
  user: BlockedPublicUserRecord;
  blockedAt: Date;
}

export type BlockUserResult =
  | { status: 'blocked'; block: UserBlockRecord }
  | { status: 'user-not-found' };

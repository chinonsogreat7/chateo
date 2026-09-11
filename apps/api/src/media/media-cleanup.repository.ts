export type MediaCleanupCandidateStatus = 'PENDING' | 'FAILED' | 'READY';

export interface MediaCleanupCandidate {
  id: string;
  cloudinaryPublicId: string;
  resourceType: 'image' | 'video' | 'raw';
  status: MediaCleanupCandidateStatus;
}

export interface FindMediaCleanupCandidatesInput {
  signatureIssuedBefore: Date;
  expiredBefore: Date;
  limit: number;
  unusedBefore?: Date;
}

export interface TransitionMediaCleanupInput {
  id: string;
  signatureIssuedBefore: Date;
  expiredBefore: Date;
  now: Date;
  unusedBefore?: Date;
}

export abstract class MediaCleanupRepository {
  abstract findCandidates(
    input: FindMediaCleanupCandidatesInput,
  ): Promise<MediaCleanupCandidate[]>;

  abstract claimExpiredPending(
    input: TransitionMediaCleanupInput,
  ): Promise<boolean>;

  abstract markDeleted(input: TransitionMediaCleanupInput): Promise<boolean>;
  abstract claimUnusedReady(
    input: TransitionMediaCleanupInput,
  ): Promise<boolean>;
}

export type MediaCleanupCandidateStatus = 'PENDING' | 'FAILED';

export interface MediaCleanupCandidate {
  id: string;
  cloudinaryPublicId: string;
  resourceType: 'image' | 'video';
  status: MediaCleanupCandidateStatus;
}

export interface FindMediaCleanupCandidatesInput {
  signatureIssuedBefore: Date;
  expiredBefore: Date;
  limit: number;
}

export interface TransitionMediaCleanupInput {
  id: string;
  signatureIssuedBefore: Date;
  expiredBefore: Date;
  now: Date;
}

export abstract class MediaCleanupRepository {
  abstract findCandidates(
    input: FindMediaCleanupCandidatesInput,
  ): Promise<MediaCleanupCandidate[]>;

  abstract claimExpiredPending(
    input: TransitionMediaCleanupInput,
  ): Promise<boolean>;

  abstract markDeleted(input: TransitionMediaCleanupInput): Promise<boolean>;
}

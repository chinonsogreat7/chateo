import type {
  CompletePendingMediaResult,
  CreatePendingMediaResult,
  MediaAssetRecord,
  MediaProfileUserRecord,
  MediaPurpose,
  MediaResourceType,
  SetProfileAvatarResult,
} from './media.types';

export interface CreatePendingMediaInput {
  id: string;
  ownerId: string;
  clientUploadId: string;
  purpose: MediaPurpose;
  uploadFingerprint: string;
  contentSha256: string | null;
  cloudinaryPublicId: string;
  resourceType: MediaResourceType;
  deliveryType: 'upload';
  mimeType: string;
  byteSize: number;
  originalFilename: string | null;
  expiresAt: Date;
  now: Date;
}

export interface CompletePendingMediaInput {
  id: string;
  ownerId: string;
  cloudinaryAssetId: string;
  format: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  secureUrl: string;
  etag: string | null;
  now: Date;
}

export abstract class MediaRepository {
  abstract createPending(
    input: CreatePendingMediaInput,
  ): Promise<CreatePendingMediaResult>;

  abstract findForOwner(
    id: string,
    ownerId: string,
  ): Promise<MediaAssetRecord | null>;

  abstract completePending(
    input: CompletePendingMediaInput,
  ): Promise<CompletePendingMediaResult>;

  abstract failPending(
    id: string,
    ownerId: string,
    now: Date,
  ): Promise<boolean>;

  abstract setProfileAvatar(
    ownerId: string,
    mediaId: string,
  ): Promise<SetProfileAvatarResult>;

  abstract clearProfileAvatar(
    ownerId: string,
  ): Promise<MediaProfileUserRecord | null>;
}

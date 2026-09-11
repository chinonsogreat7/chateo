export const PROFILE_AVATAR_PURPOSE = 'PROFILE_AVATAR' as const;
export const GROUP_AVATAR_PURPOSE = 'GROUP_AVATAR' as const;
export const MESSAGE_ATTACHMENT_PURPOSE = 'MESSAGE_ATTACHMENT' as const;
export const PENDING_MEDIA_STATUS = 'PENDING' as const;
export const READY_MEDIA_STATUS = 'READY' as const;
export const FAILED_MEDIA_STATUS = 'FAILED' as const;
export const DELETED_MEDIA_STATUS = 'DELETED' as const;

export type MediaPurpose =
  | typeof PROFILE_AVATAR_PURPOSE
  | typeof GROUP_AVATAR_PURPOSE
  | typeof MESSAGE_ATTACHMENT_PURPOSE;
export type MediaStatus =
  | typeof PENDING_MEDIA_STATUS
  | typeof READY_MEDIA_STATUS
  | typeof FAILED_MEDIA_STATUS
  | typeof DELETED_MEDIA_STATUS;
export type MediaResourceType = 'image' | 'video' | 'raw';
export type MediaType = 'image' | 'audio' | 'video' | 'document';

export interface MediaAssetRecord {
  id: string;
  ownerId: string;
  clientUploadId: string;
  purpose: MediaPurpose;
  status: MediaStatus;
  uploadFingerprint: string;
  contentSha256: string | null;
  cloudinaryPublicId: string;
  cloudinaryAssetId: string | null;
  resourceType: MediaResourceType;
  deliveryType: 'upload';
  format: string | null;
  mimeType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  originalFilename: string | null;
  secureUrl: string | null;
  etag: string | null;
  expiresAt: Date;
  completedAt: Date | null;
  failedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredImageResource {
  assetId: string;
  publicId: string;
  resourceType: string;
  deliveryType: string;
  format: string;
  byteSize: number;
  width: number;
  height: number;
  secureUrl: string;
  etag: string | null;
  context: Record<string, string>;
}

export interface StoredAudioResource {
  assetId: string;
  publicId: string;
  resourceType: string;
  deliveryType: string;
  format: string;
  byteSize: number;
  durationSeconds: number;
  secureUrl: string;
  etag: string | null;
  context: Record<string, string>;
}

export interface SignedImageUpload {
  url: string;
  method: 'POST';
  fields: {
    api_key: string;
    timestamp: string;
    signature: string;
    public_id: string;
    context: string;
    type: 'upload';
    overwrite: 'false';
    allowed_formats: 'jpg,jpeg,png,webp';
    upload_preset: string;
    transformation: string;
  };
}

export interface SignedAudioUpload {
  url: string;
  method: 'POST';
  fields: {
    api_key: string;
    timestamp: string;
    signature: string;
    public_id: string;
    context: string;
    type: 'upload';
    overwrite: 'false';
    allowed_formats: 'aac,m4a,mp3,ogg,wav';
    upload_preset: string;
  };
}

export interface StoredVideoResource extends StoredAudioResource {
  width: number;
  height: number;
  videoCodec: string;
}

export type StoredDocumentResource = Omit<
  StoredImageResource,
  'width' | 'height'
>;

export interface SignedFileUpload {
  url: string;
  method: 'POST';
  fields: Omit<SignedAudioUpload['fields'], 'allowed_formats'> & {
    allowed_formats: 'mp4,mov,webm' | 'pdf,txt,docx,xlsx,pptx';
  };
}

export interface MediaProfileUserRecord {
  id: string;
  phoneNumber: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileCompletedAt: Date | null;
  createdAt: Date;
}

export type CreatePendingMediaResult =
  | { status: 'created' | 'existing'; asset: MediaAssetRecord }
  | { status: 'idempotency-conflict' };

export type CompletePendingMediaResult =
  | { status: 'ready'; asset: MediaAssetRecord }
  | { status: 'not-found' }
  | { status: 'expired'; asset: MediaAssetRecord }
  | { status: 'not-pending'; asset: MediaAssetRecord };

export type SetProfileAvatarResult =
  | { status: 'updated'; user: MediaProfileUserRecord }
  | { status: 'media-not-found' }
  | { status: 'media-not-ready' };

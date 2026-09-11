import type {
  SignedAudioUpload,
  SignedImageUpload,
  StoredAudioResource,
  StoredImageResource,
  SignedFileUpload,
  StoredVideoResource,
  StoredDocumentResource,
} from './media.types';

export interface SignImageUploadInput {
  publicId: string;
  timestamp: Date;
  context: Record<string, string>;
}

export type SignAudioUploadInput = SignImageUploadInput;

export type MediaStorageErrorReason =
  | 'not-configured'
  | 'audio-not-configured'
  | 'video-not-configured'
  | 'document-not-configured'
  | 'unavailable'
  | 'invalid-response';

export class MediaStorageError extends Error {
  constructor(
    readonly reason: MediaStorageErrorReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = MediaStorageError.name;
  }
}

export abstract class MediaStorageProvider {
  abstract signImageUpload(
    input: SignImageUploadInput,
  ): Promise<SignedImageUpload>;

  abstract signAudioUpload(
    input: SignAudioUploadInput,
  ): Promise<SignedAudioUpload>;

  abstract findImage(publicId: string): Promise<StoredImageResource | null>;

  abstract findAudio(publicId: string): Promise<StoredAudioResource | null>;

  abstract deleteImage(publicId: string): Promise<void>;

  abstract deleteAudio(publicId: string): Promise<void>;
  abstract signVideoUpload(
    input: SignImageUploadInput,
  ): Promise<SignedFileUpload>;
  abstract signDocumentUpload(
    input: SignImageUploadInput,
  ): Promise<SignedFileUpload>;
  abstract findVideo(publicId: string): Promise<StoredVideoResource | null>;
  abstract findDocument(
    publicId: string,
  ): Promise<StoredDocumentResource | null>;
  abstract verifyDocumentContent(
    resource: StoredDocumentResource,
    mimeType: string,
    expectedSha256: string | null,
  ): Promise<boolean>;
  abstract deleteDocument(publicId: string): Promise<void>;
}

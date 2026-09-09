import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  MediaStorageError,
  MediaStorageProvider,
  type SignAudioUploadInput,
  type SignImageUploadInput,
} from './media-storage.provider';
import type {
  SignedAudioUpload,
  SignedImageUpload,
  StoredAudioResource,
  StoredImageResource,
} from './media.types';

interface CloudinaryBaseConfiguration {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
}

interface CloudinaryImageConfiguration extends CloudinaryBaseConfiguration {
  profileAvatarUploadPreset: string;
  profileAvatarMaxDimension: number;
}

interface CloudinaryAudioConfiguration extends CloudinaryBaseConfiguration {
  chatAudioUploadPreset: string;
}

interface CloudinaryResourcePayload {
  asset_id?: unknown;
  public_id?: unknown;
  resource_type?: unknown;
  type?: unknown;
  format?: unknown;
  bytes?: unknown;
  width?: unknown;
  height?: unknown;
  duration?: unknown;
  secure_url?: unknown;
  etag?: unknown;
  context?: unknown;
}

const CLOUDINARY_REQUEST_TIMEOUT_MS = 10_000;

@Injectable()
export class CloudinaryMediaProvider extends MediaStorageProvider {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async signImageUpload(
    input: SignImageUploadInput,
  ): Promise<SignedImageUpload> {
    const config = this.imageConfiguration();
    const timestamp = Math.floor(input.timestamp.getTime() / 1000).toString();
    const context = this.serializeContext(input.context);
    const transformation = `c_limit,h_${config.profileAvatarMaxDimension},w_${config.profileAvatarMaxDimension}/q_auto`;
    const parameters = {
      allowed_formats: 'jpg,jpeg,png,webp' as const,
      context,
      overwrite: 'false' as const,
      public_id: input.publicId,
      timestamp,
      transformation,
      type: 'upload' as const,
      upload_preset: config.profileAvatarUploadPreset,
    };
    const signature = this.sign(parameters, config.apiSecret);

    return {
      url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/image/upload`,
      method: 'POST',
      fields: {
        api_key: config.apiKey,
        timestamp,
        signature,
        public_id: input.publicId,
        context,
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'jpg,jpeg,png,webp',
        upload_preset: config.profileAvatarUploadPreset,
        transformation,
      },
    };
  }

  async signAudioUpload(
    input: SignAudioUploadInput,
  ): Promise<SignedAudioUpload> {
    const config = this.audioConfiguration();
    const timestamp = Math.floor(input.timestamp.getTime() / 1000).toString();
    const context = this.serializeContext(input.context);
    const parameters = {
      allowed_formats: 'aac,m4a,mp3,ogg,wav' as const,
      context,
      overwrite: 'false' as const,
      public_id: input.publicId,
      timestamp,
      type: 'upload' as const,
      upload_preset: config.chatAudioUploadPreset,
    };
    const signature = this.sign(parameters, config.apiSecret);

    return {
      url: `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/video/upload`,
      method: 'POST',
      fields: {
        api_key: config.apiKey,
        timestamp,
        signature,
        public_id: input.publicId,
        context,
        type: 'upload',
        overwrite: 'false',
        allowed_formats: 'aac,m4a,mp3,ogg,wav',
        upload_preset: config.chatAudioUploadPreset,
      },
    };
  }

  async findImage(publicId: string): Promise<StoredImageResource | null> {
    const payload = await this.findResource(publicId, 'image');
    return payload === null ? null : this.parseImageResource(payload);
  }

  async findAudio(publicId: string): Promise<StoredAudioResource | null> {
    const payload = await this.findResource(publicId, 'video');
    return payload === null ? null : this.parseAudioResource(payload);
  }

  async deleteImage(publicId: string): Promise<void> {
    await this.deleteResource(publicId, 'image');
  }

  async deleteAudio(publicId: string): Promise<void> {
    await this.deleteResource(publicId, 'video');
  }

  private async findResource(
    publicId: string,
    resourceType: 'image' | 'video',
  ): Promise<unknown | null> {
    const config = this.baseConfiguration();
    const encodedPublicId = encodeURIComponent(publicId);
    const url = `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/resources/${resourceType}/upload/${encodedPublicId}?context=true&media_metadata=true`;
    let response: Response;

    try {
      response = await fetch(url, {
        headers: {
          authorization: `Basic ${Buffer.from(`${config.apiKey}:${config.apiSecret}`, 'utf8').toString('base64')}`,
        },
        signal: AbortSignal.timeout(CLOUDINARY_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MediaStorageError(
        'unavailable',
        'Cloudinary could not be reached.',
        { cause: error },
      );
    }

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new MediaStorageError(
        'unavailable',
        `Cloudinary returned HTTP ${response.status}.`,
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new MediaStorageError(
        'invalid-response',
        'Cloudinary returned invalid JSON.',
        { cause: error },
      );
    }

    return payload;
  }

  private async deleteResource(
    publicId: string,
    resourceType: 'image' | 'video',
  ): Promise<void> {
    const config = this.baseConfiguration();
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const parameters = {
      invalidate: 'true',
      public_id: publicId,
      timestamp,
      type: 'upload',
    };
    const body = new URLSearchParams({
      ...parameters,
      api_key: config.apiKey,
      signature: this.sign(parameters, config.apiSecret),
    });
    let response: Response;
    try {
      response = await fetch(
        `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/${resourceType}/destroy`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(CLOUDINARY_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new MediaStorageError(
        'unavailable',
        'Cloudinary could not be reached for resource cleanup.',
        { cause: error },
      );
    }
    if (!response.ok) {
      throw new MediaStorageError(
        'unavailable',
        `Cloudinary cleanup returned HTTP ${response.status}.`,
      );
    }
  }

  private baseConfiguration(): CloudinaryBaseConfiguration {
    const enabled = this.config.get<boolean>('MEDIA_UPLOADS_ENABLED', false);
    if (!enabled) {
      throw new MediaStorageError(
        'not-configured',
        'Media uploads are disabled.',
      );
    }

    return {
      cloudName: this.config.getOrThrow<string>('CLOUDINARY_CLOUD_NAME'),
      apiKey: this.config.getOrThrow<string>('CLOUDINARY_API_KEY'),
      apiSecret: this.config.getOrThrow<string>('CLOUDINARY_API_SECRET'),
    };
  }

  private imageConfiguration(): CloudinaryImageConfiguration {
    return {
      ...this.baseConfiguration(),
      profileAvatarUploadPreset: this.config.getOrThrow<string>(
        'CLOUDINARY_PROFILE_AVATAR_UPLOAD_PRESET',
      ),
      profileAvatarMaxDimension: this.config.get<number>(
        'MEDIA_MAX_PROFILE_AVATAR_DIMENSION',
        2048,
      ),
    };
  }

  private audioConfiguration(): CloudinaryAudioConfiguration {
    const config = this.baseConfiguration();
    const chatAudioUploadPreset = this.config
      .get<string>('CLOUDINARY_CHAT_AUDIO_UPLOAD_PRESET', '')
      .trim();
    if (!chatAudioUploadPreset) {
      throw new MediaStorageError(
        'audio-not-configured',
        'Chat audio uploads are not configured.',
      );
    }
    return { ...config, chatAudioUploadPreset };
  }

  private serializeContext(context: Record<string, string>): string {
    return Object.entries(context)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('|');
  }

  private sign(parameters: Record<string, string>, apiSecret: string): string {
    const canonical = Object.entries(parameters)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${key}=${value}`)
      .join('&');
    return createHash('sha256')
      .update(`${canonical}${apiSecret}`, 'utf8')
      .digest('hex');
  }

  private parseImageResource(payload: unknown): StoredImageResource {
    if (!this.isObject(payload)) {
      throw this.invalidResponse();
    }
    const resource = payload as CloudinaryResourcePayload;
    if (
      !this.isNonEmptyString(resource.asset_id) ||
      !this.isNonEmptyString(resource.public_id) ||
      !this.isNonEmptyString(resource.resource_type) ||
      !this.isNonEmptyString(resource.type) ||
      !this.isNonEmptyString(resource.format) ||
      !Number.isSafeInteger(resource.bytes) ||
      (resource.bytes as number) < 1 ||
      !Number.isSafeInteger(resource.width) ||
      (resource.width as number) < 1 ||
      !Number.isSafeInteger(resource.height) ||
      (resource.height as number) < 1 ||
      !this.isHttpsUrl(resource.secure_url)
    ) {
      throw this.invalidResponse();
    }

    return {
      assetId: resource.asset_id,
      publicId: resource.public_id,
      resourceType: resource.resource_type,
      deliveryType: resource.type,
      format: resource.format.toLowerCase(),
      byteSize: resource.bytes as number,
      width: resource.width as number,
      height: resource.height as number,
      secureUrl: resource.secure_url,
      etag: this.isNonEmptyString(resource.etag) ? resource.etag : null,
      context: this.parseContext(resource.context),
    };
  }

  private parseAudioResource(payload: unknown): StoredAudioResource {
    if (!this.isObject(payload)) {
      throw this.invalidResponse();
    }
    const resource = payload as CloudinaryResourcePayload;
    if (
      !this.isNonEmptyString(resource.asset_id) ||
      !this.isNonEmptyString(resource.public_id) ||
      !this.isNonEmptyString(resource.resource_type) ||
      !this.isNonEmptyString(resource.type) ||
      !this.isNonEmptyString(resource.format) ||
      !Number.isSafeInteger(resource.bytes) ||
      (resource.bytes as number) < 1 ||
      typeof resource.duration !== 'number' ||
      !Number.isFinite(resource.duration) ||
      resource.duration <= 0 ||
      !this.isHttpsUrl(resource.secure_url)
    ) {
      throw this.invalidResponse();
    }

    return {
      assetId: resource.asset_id,
      publicId: resource.public_id,
      resourceType: resource.resource_type,
      deliveryType: resource.type,
      format: resource.format.toLowerCase(),
      byteSize: resource.bytes as number,
      durationSeconds: resource.duration,
      secureUrl: resource.secure_url,
      etag: this.isNonEmptyString(resource.etag) ? resource.etag : null,
      context: this.parseContext(resource.context),
    };
  }

  private parseContext(value: unknown): Record<string, string> {
    if (!this.isObject(value)) return {};
    const custom = this.isObject(value.custom) ? value.custom : value;
    return Object.fromEntries(
      Object.entries(custom).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  }

  private invalidResponse(): MediaStorageError {
    return new MediaStorageError(
      'invalid-response',
      'Cloudinary returned incomplete resource metadata.',
    );
  }

  private isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
  }

  private isHttpsUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
      return new URL(value).protocol === 'https:';
    } catch {
      return false;
    }
  }
}

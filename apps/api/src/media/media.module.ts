import { Module } from '@nestjs/common';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { CloudinaryMediaProvider } from './cloudinary-media.provider';
import { MediaCleanupRepository } from './media-cleanup.repository';
import { MediaCleanupService } from './media-cleanup.service';
import { MediaController } from './media.controller';
import { MediaClock, SystemMediaClock } from './media-clock';
import { MediaRepository } from './media.repository';
import { MediaService } from './media.service';
import { MediaStorageProvider } from './media-storage.provider';
import { PrismaMediaCleanupRepository } from './prisma-media-cleanup.repository';
import { PrismaMediaRepository } from './prisma-media.repository';
import { ProfileAvatarController } from './profile-avatar.controller';

@Module({
  controllers: [MediaController, ProfileAvatarController],
  providers: [
    MediaService,
    MediaCleanupService,
    PrismaMediaRepository,
    { provide: MediaRepository, useExisting: PrismaMediaRepository },
    PrismaMediaCleanupRepository,
    {
      provide: MediaCleanupRepository,
      useExisting: PrismaMediaCleanupRepository,
    },
    CloudinaryMediaProvider,
    { provide: MediaStorageProvider, useExisting: CloudinaryMediaProvider },
    SystemMediaClock,
    { provide: MediaClock, useExisting: SystemMediaClock },
    NoStoreInterceptor,
  ],
  exports: [MediaService, MediaRepository],
})
export class MediaModule {}

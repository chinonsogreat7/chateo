import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../auth/providers/clock';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { RealtimeModule } from '../realtime/realtime.module';
import { ConversationSettingsController } from './conversation-settings.controller';
import { ConversationSettingsRepository } from './conversation-settings.repository';
import { ConversationSettingsService } from './conversation-settings.service';
import { PrismaConversationSettingsRepository } from './prisma-conversation-settings.repository';

@Module({
  imports: [RealtimeModule],
  controllers: [ConversationSettingsController],
  providers: [
    ConversationSettingsService,
    PrismaConversationSettingsRepository,
    {
      provide: ConversationSettingsRepository,
      useExisting: PrismaConversationSettingsRepository,
    },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
    NoStoreInterceptor,
  ],
  exports: [ConversationSettingsService, ConversationSettingsRepository],
})
export class ConversationSettingsModule {}

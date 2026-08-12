import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../auth/providers/clock';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { ConversationsController } from './conversations.controller';
import { ConversationsRepository } from './conversations.repository';
import { ConversationsService } from './conversations.service';
import { PrismaConversationsRepository } from './prisma-conversations.repository';

@Module({
  controllers: [ConversationsController],
  providers: [
    ConversationsService,
    PrismaConversationsRepository,
    {
      provide: ConversationsRepository,
      useExisting: PrismaConversationsRepository,
    },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
    NoStoreInterceptor,
  ],
  exports: [ConversationsService],
})
export class ConversationsModule {}

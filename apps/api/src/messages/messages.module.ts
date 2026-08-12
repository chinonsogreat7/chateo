import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../auth/providers/clock';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { RealtimeModule } from '../realtime/realtime.module';
import { MessagesController } from './messages.controller';
import { MessagesRepository } from './messages.repository';
import { MessagesService } from './messages.service';
import { PrismaMessagesRepository } from './prisma-messages.repository';

@Module({
  imports: [RealtimeModule],
  controllers: [MessagesController],
  providers: [
    MessagesService,
    PrismaMessagesRepository,
    { provide: MessagesRepository, useExisting: PrismaMessagesRepository },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
    NoStoreInterceptor,
  ],
  exports: [MessagesService],
})
export class MessagesModule {}

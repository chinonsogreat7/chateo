import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { Clock, SystemClock } from '../auth/providers/clock';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { ReceiptEventsPublisher } from '../receipts/receipt-events.publisher';
import { ChatGateway } from './chat.gateway';
import { ChatStateService } from './chat-state.service';
import { RealtimeAuthenticator } from './realtime-authenticator';
import {
  PrismaRealtimeConversationsRepository,
  RealtimeConversationsRepository,
} from './realtime-conversations.repository';
import { RealtimeMessageEventsPublisher } from './realtime-message-events.publisher';
import { RealtimeReceiptEventsPublisher } from './realtime-receipt-events.publisher';

@Module({
  imports: [AuthModule],
  providers: [
    ChatGateway,
    ChatStateService,
    RealtimeAuthenticator,
    PrismaRealtimeConversationsRepository,
    {
      provide: RealtimeConversationsRepository,
      useExisting: PrismaRealtimeConversationsRepository,
    },
    RealtimeMessageEventsPublisher,
    RealtimeReceiptEventsPublisher,
    {
      provide: MessageEventsPublisher,
      useExisting: RealtimeMessageEventsPublisher,
    },
    {
      provide: ReceiptEventsPublisher,
      useExisting: RealtimeReceiptEventsPublisher,
    },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
  ],
  exports: [
    ChatGateway,
    RealtimeMessageEventsPublisher,
    MessageEventsPublisher,
    RealtimeReceiptEventsPublisher,
    ReceiptEventsPublisher,
  ],
})
export class RealtimeModule {}

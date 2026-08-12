import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { Clock, SystemClock } from '../auth/providers/clock';
import { MessageEventsPublisher } from '../messages/message-events.publisher';
import { ChatGateway } from './chat.gateway';
import { RealtimeAuthenticator } from './realtime-authenticator';
import { RealtimeMessageEventsPublisher } from './realtime-message-events.publisher';

@Module({
  imports: [AuthModule],
  providers: [
    ChatGateway,
    RealtimeAuthenticator,
    RealtimeMessageEventsPublisher,
    {
      provide: MessageEventsPublisher,
      useExisting: RealtimeMessageEventsPublisher,
    },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
  ],
  exports: [
    ChatGateway,
    RealtimeMessageEventsPublisher,
    MessageEventsPublisher,
  ],
})
export class RealtimeModule {}

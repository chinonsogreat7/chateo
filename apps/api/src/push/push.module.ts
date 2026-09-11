import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { Clock, SystemClock } from '../auth/providers/clock';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { RealtimeModule } from '../realtime/realtime.module';
import { ExpoPushProvider, PushProvider } from './expo-push.provider';
import { PushController } from './push.controller';
import { PushRepository } from './push.repository';
import { PushPresenceService } from './push-presence.service';
import { PushWorkerService } from './push-worker.service';

@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [PushController],
  providers: [
    PushRepository,
    PushPresenceService,
    PushWorkerService,
    ExpoPushProvider,
    { provide: PushProvider, useExisting: ExpoPushProvider },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
    NoStoreInterceptor,
  ],
})
export class PushModule {}

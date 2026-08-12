import { Module } from '@nestjs/common';
import { Clock, SystemClock } from '../auth/providers/clock';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { RealtimeModule } from '../realtime/realtime.module';
import { PrismaReceiptsRepository } from './prisma-receipts.repository';
import { ReceiptsController } from './receipts.controller';
import { ReceiptsRepository } from './receipts.repository';
import { ReceiptsService } from './receipts.service';

@Module({
  imports: [RealtimeModule],
  controllers: [ReceiptsController],
  providers: [
    ReceiptsService,
    PrismaReceiptsRepository,
    { provide: ReceiptsRepository, useExisting: PrismaReceiptsRepository },
    SystemClock,
    { provide: Clock, useExisting: SystemClock },
    NoStoreInterceptor,
  ],
  exports: [ReceiptsService, ReceiptsRepository],
})
export class ReceiptsModule {}

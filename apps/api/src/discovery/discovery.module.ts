import { Module } from '@nestjs/common';
import { PhoneNumberService } from '../auth/providers/phone-number.service';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryRepository } from './discovery.repository';
import { DiscoveryService } from './discovery.service';
import { PrismaDiscoveryRepository } from './prisma-discovery.repository';

@Module({
  controllers: [DiscoveryController],
  providers: [
    DiscoveryService,
    PrismaDiscoveryRepository,
    { provide: DiscoveryRepository, useExisting: PrismaDiscoveryRepository },
    PhoneNumberService,
    NoStoreInterceptor,
  ],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}

import { Module } from '@nestjs/common';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { BlocksController } from './blocks.controller';
import { BlocksRepository } from './blocks.repository';
import { BlocksService } from './blocks.service';
import { PrismaBlocksRepository } from './prisma-blocks.repository';

@Module({
  controllers: [BlocksController],
  providers: [
    BlocksService,
    PrismaBlocksRepository,
    { provide: BlocksRepository, useExisting: PrismaBlocksRepository },
    NoStoreInterceptor,
  ],
  exports: [BlocksService, BlocksRepository],
})
export class BlocksModule {}

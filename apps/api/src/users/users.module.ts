import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController],
  providers: [UsersService, NoStoreInterceptor],
})
export class UsersModule {}

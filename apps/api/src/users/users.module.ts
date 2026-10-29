import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { NoStoreInterceptor } from '../common/no-store.interceptor';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ParticipantProfilesController } from './participant-profiles.controller';
import { ParticipantProfilesService } from './participant-profiles.service';

@Module({
  imports: [AuthModule],
  controllers: [UsersController, ParticipantProfilesController],
  providers: [UsersService, ParticipantProfilesService, NoStoreInterceptor],
})
export class UsersModule {}

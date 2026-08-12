import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/errors/api.exception';
import { AuthRepository } from '../auth/auth.repository';
import type { AuthUserRecord } from '../auth/auth.types';
import type { UserResponseDto } from '../auth/dto/auth-response.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private readonly repository: AuthRepository) {}

  async getMe(userId: string): Promise<UserResponseDto> {
    const user = await this.repository.findUserById(userId);
    if (!user) throw this.userNotFoundException();
    return this.toResponse(user);
  }

  async updateMe(
    userId: string,
    input: UpdateProfileDto,
  ): Promise<UserResponseDto> {
    if (input.displayName === undefined && input.avatarUrl === undefined) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'PROFILE_UPDATE_EMPTY',
        'Provide at least one profile field to update.',
      );
    }

    const user = await this.repository.updateUserProfile(
      userId,
      {
        displayName: input.displayName,
        avatarUrl: input.avatarUrl,
      },
      new Date(),
    );
    if (!user) throw this.userNotFoundException();
    return this.toResponse(user);
  }

  private toResponse(user: AuthUserRecord): UserResponseDto {
    return {
      id: user.id,
      phoneNumber: user.phoneNumber,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileComplete: user.profileCompletedAt !== null,
      createdAt: user.createdAt.toISOString(),
    };
  }

  private userNotFoundException(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'USER_NOT_FOUND',
      'The signed-in user no longer exists.',
    );
  }
}

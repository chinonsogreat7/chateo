import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ApiException } from '../common/errors/api.exception';
import { IS_PUBLIC_KEY } from '../common/decorators/public.decorator';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../common/types/authenticated-request';
import { AuthRepository } from './auth.repository';
import { Clock } from './providers/clock';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly repository: AuthRepository,
    private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request.headers.authorization);
    if (!token) throw this.unauthorizedException();

    let payload: AuthenticatedUser;
    try {
      payload = await this.jwtService.verifyAsync<AuthenticatedUser>(token);
    } catch {
      throw this.unauthorizedException();
    }

    if (
      typeof payload.sub !== 'string' ||
      typeof payload.sid !== 'string' ||
      typeof payload.profileComplete !== 'boolean'
    ) {
      throw this.unauthorizedException();
    }

    const active = await this.repository.isSessionActive(
      payload.sid,
      payload.sub,
      this.clock.now(),
    );
    if (!active) throw this.unauthorizedException();

    request.user = payload;
    return true;
  }

  private extractBearerToken(value: string | undefined): string | null {
    const [type, token] = value?.split(' ') ?? [];
    return type === 'Bearer' && token ? token : null;
  }

  private unauthorizedException(): ApiException {
    return new ApiException(
      HttpStatus.UNAUTHORIZED,
      'AUTH_ACCESS_TOKEN_INVALID',
      'A valid access token is required.',
    );
  }
}

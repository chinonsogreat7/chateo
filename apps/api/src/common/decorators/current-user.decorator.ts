import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type {
  AuthenticatedRequest,
  AuthenticatedUser,
} from '../types/authenticated-request';

export const CurrentUser = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext,
  ): AuthenticatedUser | undefined => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);

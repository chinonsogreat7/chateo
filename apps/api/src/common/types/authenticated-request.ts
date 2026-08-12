import type { Request } from 'express';

export interface AuthenticatedUser {
  sub: string;
  sid: string;
  profileComplete: boolean;
}

export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

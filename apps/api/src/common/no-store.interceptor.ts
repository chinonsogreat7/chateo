import {
  CallHandler,
  ExecutionContext,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import type { Observable } from 'rxjs';

@Injectable()
export class NoStoreInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const response = context.switchToHttp().getResponse<Response>();
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Pragma', 'no-cache');
    return next.handle();
  }
}

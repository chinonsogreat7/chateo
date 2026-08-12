import { HttpException, type HttpStatus } from '@nestjs/common';

export interface ApiErrorDetails {
  [key: string]: unknown;
}

export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    code: string,
    message: string,
    details?: ApiErrorDetails,
  ) {
    super({ code, message, ...(details ? { details } : {}) }, status);
  }
}

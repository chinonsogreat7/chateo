import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Request, Response } from 'express';

interface ErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(ApiExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const context = host.switchToHttp();
    const response = context.getResponse<Response>();
    const request = context.getRequest<Request>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        exception instanceof Error ? exception.message : 'Unknown server error',
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    const payload = this.toPayload(exception, status);
    response.status(status).json({
      statusCode: status,
      ...payload,
      path: request.originalUrl,
      timestamp: new Date().toISOString(),
    });
  }

  private toPayload(exception: unknown, status: number): ErrorPayload {
    if (!(exception instanceof HttpException)) {
      return {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred.',
      };
    }

    const response = exception.getResponse();
    if (typeof response === 'string') {
      return {
        code: this.defaultCode(status),
        message: response,
      };
    }

    if (isRecord(response) && typeof response.code === 'string') {
      return {
        code: response.code,
        message:
          typeof response.message === 'string'
            ? response.message
            : exception.message,
        ...(response.details === undefined
          ? {}
          : { details: response.details }),
      };
    }

    if (isRecord(response) && Array.isArray(response.message)) {
      return {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed.',
        details: { errors: response.message },
      };
    }

    return {
      code: this.defaultCode(status),
      message:
        isRecord(response) && typeof response.message === 'string'
          ? response.message
          : exception.message,
    };
  }

  private defaultCode(status: number): string {
    if (status === HttpStatus.BAD_REQUEST) return 'BAD_REQUEST';
    if (status === HttpStatus.UNAUTHORIZED) return 'UNAUTHORIZED';
    if (status === HttpStatus.FORBIDDEN) return 'FORBIDDEN';
    if (status === HttpStatus.NOT_FOUND) return 'NOT_FOUND';
    if (status === HttpStatus.TOO_MANY_REQUESTS) return 'RATE_LIMITED';
    return 'HTTP_ERROR';
  }
}

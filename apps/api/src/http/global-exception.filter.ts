import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logStructured } from '../logging/logger';
import { scrubFreeText } from '../platform/support-bundle/support-bundle.service';

/**
 * Global exception filter (P3 item 13/23 - logging/error review).
 *
 * Before this existed, there was NO global exception filter anywhere in
 * this codebase - every uncaught error fell through to Fastify/Nest's
 * built-in default handling. That default is already reasonably safe (Nest
 * does not echo a raw error's `.message`/stack for a non-HttpException by
 * default), but it gives ordinary users no REFERENCE ID to quote when
 * contacting support (item 23: "understandable message + next action +
 * reference ID where useful"), and does not consistently log the full
 * error server-side with a correlation id an admin could later correlate
 * against a support bundle's job/webhook/integration failure summaries.
 *
 * Two distinct paths:
 *   1. HttpException (BadRequestException, ForbiddenException, etc.) -
 *      these are ALREADY our own code deliberately choosing a safe,
 *      reviewed message for the caller (every existing controller in this
 *      codebase throws these intentionally) - passed through as-is, no
 *      behaviour change, just a referenceId added for consistency and a
 *      server-side log line for traceability.
 *   2. Anything else (a raw JS Error - a Postgres driver error, a
 *      TypeError from a bug, etc.) - NEVER exposed to the caller. The
 *      client gets a generic message + referenceId only; the full error
 *      (message, stack, code) is logged server-side via logStructured,
 *      with the free-text error message passed through scrubFreeText()
 *      (support-bundle.service.ts) as defense-in-depth against an error
 *      message that happens to echo a credential (the exact realistic
 *      leak vector that module's own tests found and fixed).
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<FastifyReply>();
    const request = ctx.getRequest<FastifyRequest>();
    const referenceId = (request as any).id ?? 'unknown';

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const normalized = typeof body === 'string' ? { message: body } : (body as Record<string, unknown>);

      logStructured({
        event: 'http.request.error',
        level: status >= 500 ? 'error' : 'warn',
        errorCode: `HTTP_${status}`,
        correlationId: referenceId,
        context: { path: request.url, method: request.method, status },
      });

      response.status(status).send({ ...normalized, referenceId });
      return;
    }

    // Not an HttpException - a genuinely unexpected error. Never leak
    // exception.message/stack/SQL to the caller.
    const err = exception instanceof Error ? exception : new Error(String(exception));
    logStructured({
      event: 'http.request.unhandled_error',
      level: 'error',
      errorCode: 'INTERNAL_ERROR',
      correlationId: referenceId,
      context: {
        path: request.url,
        method: request.method,
        errorMessage: scrubFreeText(err.message ?? 'unknown'),
        errorName: err.name,
      },
    });

    response.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message: `An unexpected error occurred. If this persists, contact support with reference ID ${referenceId}.`,
      referenceId,
    });
  }
}

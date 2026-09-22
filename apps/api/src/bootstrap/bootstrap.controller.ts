import { Body, Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { BootstrapService, CompleteBootstrapInput } from './bootstrap.service';
import { PublicRoute } from '../http/session-auth.guard';
import { enforceRateLimit, bootstrapRateLimiters } from '../security/rate-limits';

@Controller('api/v1/bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @PublicRoute()
  @Post('complete')
  async complete(@Req() req: FastifyRequest, @Body() body: CompleteBootstrapInput) {
    // IP-based only (no account exists yet to key against) - defense in
    // depth on top of the token itself being a 256-bit unguessable secret.
    enforceRateLimit(bootstrapRateLimiters, null, req.ip);
    return this.bootstrap.completeBootstrap(body);
  }
}

import { Controller, Get } from '@nestjs/common';
import { PublicRoute } from '../http/session-auth.guard';

@Controller('api/v1/health')
export class HealthController {
  @PublicRoute()
  @Get()
  check() {
    return { status: 'ok' };
  }
}

import { Body, Controller, Post } from '@nestjs/common';
import { BootstrapService, CompleteBootstrapInput } from './bootstrap.service';
import { PublicRoute } from '../http/session-auth.guard';

@Controller('api/v1/bootstrap')
export class BootstrapController {
  constructor(private readonly bootstrap: BootstrapService) {}

  @PublicRoute()
  @Post('complete')
  async complete(@Body() body: CompleteBootstrapInput) {
    return this.bootstrap.completeBootstrap(body);
  }
}

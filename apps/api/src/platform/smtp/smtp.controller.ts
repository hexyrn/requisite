import { Body, Controller, Delete, Get, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { RequirePermission } from '../../rbac/permission.guard';
import { CORE_PERMISSIONS } from '../../rbac/permissions';
import { getPool } from '../../db/pool';
import { SmtpConfigService, SmtpConfig } from './smtp-config.service';
import { sendSmtpMail } from './smtp-client';

/**
 * SMTP admin endpoints (P3 item 9/24). Gated by ORGANISATION_MANAGE (the
 * same permission AppStateController uses for other installation-adjacent
 * admin surfaces) - SMTP is a deployment-level setting, not a
 * per-organisation business record, but this codebase's v1 product
 * constraint is "exactly one organisation per installation" (Architecture
 * §7), so gating on the org-admin permission is the correct, available
 * seam rather than inventing a separate installation-admin permission
 * tier for a single setting.
 */
@Controller('api/v1/smtp')
export class SmtpController {
  constructor(private readonly config: SmtpConfigService) {}

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Get()
  async getConfig() {
    return this.config.getConfigForDisplay(getPool());
  }

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post()
  async setConfig(@Body() body: SmtpConfigInput) {
    const config: SmtpConfig = {
      host: body.host,
      port: body.port,
      secure: body.secure,
      username: body.username ?? null,
      // A blank/omitted password means "keep the existing one" if already
      // configured - only an explicitly non-empty password overwrites it,
      // so an admin editing the host/port doesn't have to re-enter (or
      // accidentally blank out) a password they can never see again.
      password:
        body.password && body.password.length > 0
          ? body.password
          : await this.keepExistingPassword(),
      fromAddress: body.fromAddress,
    };
    await this.config.setConfig(getPool(), config);
    return this.config.getConfigForDisplay(getPool());
  }

  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Delete()
  async clearConfig() {
    await this.config.clearConfig(getPool());
    return { cleared: true };
  }

  /**
   * Item 9: "connection/test-email function; actionable error reporting."
   * Sends a real message through the currently SAVED configuration (never
   * an unsaved one from the request body - a test send always exercises
   * exactly what production sends would use, closing the gap where a test
   * button proves something different from what's actually configured).
   */
  @RequirePermission(CORE_PERMISSIONS.ORGANISATION_MANAGE)
  @Post('test')
  async sendTestEmail(@Req() req: FastifyRequest, @Body() body: { to: string }) {
    const config = await this.config.getConfigForSending(getPool());
    if (!config) {
      return {
        success: false,
        error: 'SMTP is not configured yet - set a configuration before sending a test email.',
      };
    }
    const user = (req as any).currentUser;
    return sendSmtpMail(config, {
      to: body.to,
      subject: 'Hexyrn Core - test email',
      text: `This is a test email sent from Hexyrn Core by ${user?.email ?? 'an administrator'} to confirm SMTP delivery is working.`,
    });
  }

  private async keepExistingPassword(): Promise<string | null> {
    const config = await this.config.getConfigForSending(getPool());
    return config?.password ?? null;
  }
}

interface SmtpConfigInput {
  host: string;
  port: number;
  secure: boolean;
  username?: string | null;
  password?: string | null;
  fromAddress: string;
}

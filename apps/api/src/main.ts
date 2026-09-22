import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { AppModule } from './app.module';
import { InstallationService } from './bootstrap/installation.service';
import { ApplicationRegistryService } from './platform/app-registry/application-registry.service';
import { registerReferenceApp } from './apps/reference/reference.manifest';
import { registerRequisiteApp } from './apps/requisite/requisite.manifest';
import { registerRequisiteP2Extensions } from './apps/requisite/requisite-p2-extensions';
import { DeliveryMonitoringService, DELIVERY_MONITORING_JOB_TYPE } from './apps/requisite/delivery-monitoring.service';
import { JobHandlerRegistryService } from './platform/scheduling/scheduled-job.service';
import { ScheduledReportService, SCHEDULED_REPORT_JOB_TYPE } from './platform/reporting/scheduled-report.service';
import { ConnectorRegistryService } from './platform/integrations/connector-registry.service';
import { SyncAdapterRegistryService } from './platform/integrations/sync-adapter-registry.service';
import { SyncHandlerRegistryService } from './platform/integrations/sync-row-handler';
import { registerReferenceConnector } from './apps/reference/reference-connector';
import { registerReferenceAppP2Extensions } from './apps/reference/reference-p2-extensions';
import { DatasetService } from './platform/reporting/dataset.service';
import { SavedReportService } from './platform/reporting/saved-report.service';
import { DashboardService } from './platform/dashboards/dashboard.service';
import { SearchService } from './platform/search/search.service';
import { ImportService } from './platform/import/import.service';
import { ImportHandlerRegistryService } from './platform/import/import-row-handler';
import { EventSchemaService } from './platform/events/event-schema.service';
import { assertProductionConfigOrThrow } from './config/production-config-check';

async function bootstrap() {
  // P3 item 39: fail fast and loudly with NODE_ENV=production and a
  // critical secret missing/invalid, rather than booting successfully and
  // failing confusingly deep inside a later request (or, worse, silently
  // running with an insecure default - see production-config-check.ts's
  // doc comment for the exact failure modes this closes).
  assertProductionConfigOrThrow();

  const adapter = new FastifyAdapter({ trustProxy: parseTrustedProxies() });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  await app.register(fastifyCookie as any);
  // Core multipart file upload (P2 item 16 -> Requisite UI item 17): the
  // same 25MB/MIME-sniffing limits FileService already enforces apply
  // regardless of upload transport - this plugin only gets bytes off the
  // wire, it does not weaken any existing security control.
  await app.register(fastifyMultipart as any, { limits: { fileSize: 25 * 1024 * 1024 } });

  // Input validation layer - P1 item 15 (addresses the P0 DTO/validation
  // debt). Every controller's @Body()/@Query()/@Param() DTO is now run
  // through class-validator BEFORE the handler executes; malformed input
  // gets a structured 400 here, never falls through to a raw Postgres
  // error. `whitelist: true` strips any property not declared on the DTO
  // (defense in depth against mass assignment, on top of every service's
  // own explicit field enumeration - see the P0 security review),
  // `forbidNonWhitelisted: true` makes an unexpected property a hard
  // validation error rather than a silent drop, and `transform: true` lets
  // DTOs use real types (numbers, dates) instead of everything being a
  // string. This is the standard every future app's own controllers are
  // expected to follow - see docs/APP_SDK.md.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Security headers - Architecture §6.
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onSend', (_req: any, reply: any, payload: any, done: any) => {
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header('X-Frame-Options', 'DENY');
      reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'",
      );
      if (process.env.COOKIE_SECURE !== 'false') {
        reply.header('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
      }
      done(null, payload);
    });

  // Origin validation for state-changing requests - second layer alongside CSRF, Architecture §6.
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  app
    .getHttpAdapter()
    .getInstance()
    .addHook('onRequest', (req: any, reply: any, done: any) => {
      const mutating = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method);
      if (mutating && allowedOrigins.length > 0) {
        const origin = req.headers['origin'];
        if (origin && !allowedOrigins.includes(origin)) {
          reply.code(403).send({ errorCode: 'ORIGIN_NOT_ALLOWED', message: 'Origin not allowed.' });
          return;
        }
      }
      done();
    });

  app.enableCors({ origin: allowedOrigins.length > 0 ? allowedOrigins : false, credentials: true });

  // Ensures the installation row + one-time bootstrap token exist on first boot (P0 items 5/6).
  const installationService = app.get(InstallationService);
  await installationService.ensureInstallation();

  // Registers every compiled-in app's manifest at boot (Architecture §3 v1
  // packaging: "monorepo workspace packages, compiled into one build").
  // com.hexyrn.reference is the only app registered in P1 - see
  // docs/decisions and docs/BUILD_YOUR_FIRST_APP.md.
  const registry = app.get(ApplicationRegistryService);
  await registerReferenceApp(registry);
  await registerRequisiteApp(registry);
  await registerRequisiteP2Extensions(
    app.get(DatasetService),
    app.get(SavedReportService),
    app.get(DashboardService),
    app.get(SearchService),
    app.get(ImportService),
    app.get(ImportHandlerRegistryService),
  );

  // Wires the Scheduled Reports (P2 item 8) job handler into the SAME P1
  // job-handler registry every other background job type uses - see
  // scheduled-report.service.ts's doc comment for why this reuses the
  // existing scheduling engine instead of a second one.
  const jobHandlers = app.get(JobHandlerRegistryService);
  const scheduledReports = app.get(ScheduledReportService);
  jobHandlers.register(SCHEDULED_REPORT_JOB_TYPE, (db, organisationId, payload) =>
    scheduledReports.runDelivery(db, organisationId, payload.scheduledReportId as string),
  );

  // Requisite delivery-monitoring reminders (item 18) - same scheduling-
  // engine reuse pattern as scheduled reports above.
  const deliveryMonitoring = app.get(DeliveryMonitoringService);
  jobHandlers.register(DELIVERY_MONITORING_JOB_TYPE, (db, organisationId) => deliveryMonitoring.runCheck(db, organisationId).then(() => undefined));

  // Registers the reference connector (P2 item 27) the same way the
  // reference app itself is registered above - a compiled-in demonstration
  // of the Integration Framework/Sync Engine end to end.
  await registerReferenceConnector(app.get(ConnectorRegistryService), app.get(SyncAdapterRegistryService), app.get(SyncHandlerRegistryService));

  // Registers com.hexyrn.reference against every P2 extension point
  // (P2 item 26) - dataset/relationship, saved report template, dashboard
  // widget, search participation, import definition + handler, event
  // schema.
  await registerReferenceAppP2Extensions(
    app.get(DatasetService),
    app.get(SavedReportService),
    app.get(DashboardService),
    app.get(SearchService),
    app.get(ImportService),
    app.get(ImportHandlerRegistryService),
    app.get(EventSchemaService),
  );

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Hexyrn Core API listening on port ${port}`);
}

function parseTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

bootstrap();

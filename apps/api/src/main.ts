import 'reflect-metadata';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import fastifyCookie from '@fastify/cookie';
import { AppModule } from './app.module';
import { InstallationService } from './bootstrap/installation.service';

async function bootstrap() {
  const adapter = new FastifyAdapter({ trustProxy: parseTrustedProxies() });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  await app.register(fastifyCookie as any);

  // Security headers - Architecture §6.
  app.getHttpAdapter().getInstance().addHook('onSend', (_req: any, reply: any, payload: any, done: any) => {
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
  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  app.getHttpAdapter().getInstance().addHook('onRequest', (req: any, reply: any, done: any) => {
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

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`Hexyrn Core API listening on port ${port}`);
}

function parseTrustedProxies(): string[] {
  return (process.env.TRUSTED_PROXY_CIDRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

bootstrap();

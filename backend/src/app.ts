import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyInstance } from 'fastify';
import { AppConfig } from './config/env';
import { OutreachDb } from './db/types';
import { sendError } from './middleware/auth';
import { registerCampaignRoutes } from './routes/campaigns.routes';
import { registerContactRoutes } from './routes/contacts.routes';
import { registerGmailRoutes } from './routes/gmail.routes';
import { registerHistoryRoutes } from './routes/index';
import { registerSuppressionRoutes } from './routes/suppressions.routes';
import { AppError } from './utils/errors';

export interface AppDeps {
  config: AppConfig;
  db: OutreachDb;
  enqueue?: (campaignRecipientId: string) => Promise<void>;
}

function originAllowed(origin: string | undefined, config: AppConfig): boolean {
  if (!origin) return true;
  if (config.extensionOrigin && origin === config.extensionOrigin) return true;
  if (!config.extensionOrigin && origin.startsWith('chrome-extension://')) return true;
  return false;
}

export async function createApp(deps: AppDeps): Promise<FastifyInstance> {
  const enqueue = deps.enqueue ?? (async () => undefined);
  const app = Fastify({
    logger: {
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cors, {
    origin: (origin, callback) => {
      if (originAllowed(origin, deps.config)) callback(null, true);
      else callback(new Error('Origin not allowed'), false);
    },
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  });

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error({ err: error }, 'request failed');
    return sendError(reply, error);
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Route not found', details: {} },
    });
  });

  app.get('/api/health', async () => ({ ok: true, service: 'npm-outreach-api' }));

  registerGmailRoutes(app, deps.db, deps.config);
  registerContactRoutes(app, deps.db, deps.config);
  registerCampaignRoutes(app, deps.db, deps.config, enqueue);
  registerSuppressionRoutes(app, deps.db, deps.config);
  registerHistoryRoutes(app, deps.db, deps.config);

  app.get('/', async () => ({ ok: true, service: 'npm-outreach-api' }));

  return app;
}

export function assertConfig(config: AppConfig): void {
  if (!config.apiKey) {
    throw new AppError(500, 'CONFIG', 'BACKEND_API_KEY is required');
  }
}

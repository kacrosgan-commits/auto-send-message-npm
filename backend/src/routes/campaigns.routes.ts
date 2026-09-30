import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env.js';
import { campaignsController } from '../controllers/campaigns.controller.js';
import { OutreachDb } from '../db/types.js';
import { requireApiKey } from '../middleware/auth.js';

const sensitive = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export function registerCampaignRoutes(
  app: FastifyInstance,
  db: OutreachDb,
  config: AppConfig,
  enqueue: (id: string) => Promise<void>,
) {
  const campaigns = campaignsController(db, config, enqueue);
  const auth = requireApiKey(config);
  app.post('/api/campaigns', { preHandler: auth, ...sensitive }, campaigns.create);
  app.get('/api/campaigns', { preHandler: auth }, campaigns.list);
  app.get('/api/campaigns/:id', { preHandler: auth }, campaigns.get);
  app.patch('/api/campaigns/:id', { preHandler: auth }, campaigns.patch);
  app.delete('/api/campaigns/:id', { preHandler: auth }, campaigns.remove);
  app.post('/api/campaigns/:id/recipients', { preHandler: auth, ...sensitive }, campaigns.recipients);
  app.post('/api/campaigns/:id/queue', { preHandler: auth, ...sensitive }, campaigns.queue);
  app.post('/api/campaigns/:id/start', { preHandler: auth, ...sensitive }, campaigns.control('start'));
  app.post('/api/campaigns/:id/pause', { preHandler: auth, ...sensitive }, campaigns.control('pause'));
  app.post('/api/campaigns/:id/resume', { preHandler: auth, ...sensitive }, campaigns.control('resume'));
  app.post('/api/campaigns/:id/cancel', { preHandler: auth, ...sensitive }, campaigns.control('cancel'));
}

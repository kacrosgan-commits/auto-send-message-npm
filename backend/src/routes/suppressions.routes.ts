import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env.js';
import { suppressionsController } from '../controllers/suppressions.controller.js';
import { OutreachDb } from '../db/types.js';
import { requireApiKey } from '../middleware/auth.js';

const sensitive = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export function registerSuppressionRoutes(app: FastifyInstance, db: OutreachDb, config: AppConfig) {
  const suppressions = suppressionsController(db);
  const auth = requireApiKey(config);
  app.get('/api/suppressions', { preHandler: auth }, suppressions.list);
  app.post('/api/suppressions', { preHandler: auth, ...sensitive }, suppressions.create);
  app.delete('/api/suppressions/:id', { preHandler: auth }, suppressions.remove);
}

import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env';
import { suppressionsController } from '../controllers/suppressions.controller';
import { OutreachDb } from '../db/types';
import { requireApiKey } from '../middleware/auth';

const sensitive = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export function registerSuppressionRoutes(app: FastifyInstance, db: OutreachDb, config: AppConfig) {
  const suppressions = suppressionsController(db);
  const auth = requireApiKey(config);
  app.get('/api/suppressions', { preHandler: auth }, suppressions.list);
  app.post('/api/suppressions', { preHandler: auth, ...sensitive }, suppressions.create);
  app.delete('/api/suppressions/:id', { preHandler: auth }, suppressions.remove);
}

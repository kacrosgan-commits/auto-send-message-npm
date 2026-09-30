import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env';
import { historyController } from '../controllers/history.controller';
import { OutreachDb } from '../db/types';
import { requireApiKey } from '../middleware/auth';

export function registerHistoryRoutes(app: FastifyInstance, db: OutreachDb, config: AppConfig) {
  const history = historyController(db);
  app.get('/api/history', { preHandler: requireApiKey(config) }, history.list);
}

import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env.js';
import { historyController } from '../controllers/history.controller.js';
import { OutreachDb } from '../db/types.js';
import { requireApiKey } from '../middleware/auth.js';

export function registerHistoryRoutes(app: FastifyInstance, db: OutreachDb, config: AppConfig) {
  const history = historyController(db);
  app.get('/api/history', { preHandler: requireApiKey(config) }, history.list);
}

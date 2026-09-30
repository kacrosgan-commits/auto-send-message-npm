import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env.js';
import { contactsController } from '../controllers/contacts.controller.js';
import { OutreachDb } from '../db/types.js';
import { requireApiKey } from '../middleware/auth.js';

const sensitive = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export function registerContactRoutes(app: FastifyInstance, db: OutreachDb, config: AppConfig) {
  const contacts = contactsController(db);
  const auth = requireApiKey(config);
  app.post('/api/contacts/ingest', { preHandler: auth, ...sensitive }, contacts.ingest);
  app.get('/api/contacts', { preHandler: auth }, contacts.list);
  app.get('/api/contacts/stats', { preHandler: auth }, contacts.stats);
}

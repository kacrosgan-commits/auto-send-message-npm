import { FastifyInstance } from 'fastify';
import { AppConfig } from '../config/env';
import { gmailController, unsubscribeController } from '../controllers/gmail.controller';
import { OutreachDb } from '../db/types';
import { requireApiKey } from '../middleware/auth';

const sensitive = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };

export function registerGmailRoutes(app: FastifyInstance, db: OutreachDb, config: AppConfig) {
  const gmail = gmailController(db, config);
  const unsubscribe = unsubscribeController(db);
  const auth = requireApiKey(config);
  app.get('/api/auth/google/callback', gmail.callback);
  app.get('/api/auth/google', { preHandler: auth, ...sensitive }, gmail.start);
  app.get('/api/gmail/account', { preHandler: auth }, gmail.account);
  app.post('/api/gmail/disconnect', { preHandler: auth, ...sensitive }, gmail.disconnect);
  app.get('/unsubscribe/:token', unsubscribe.show);
}

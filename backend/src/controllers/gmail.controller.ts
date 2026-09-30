import { FastifyReply, FastifyRequest } from 'fastify';
import { AppConfig } from '../config/env';
import { OutreachDb } from '../db/types';
import { beginGoogleAuth, completeGoogleAuth, disconnectGmail, getGmailAccountView } from '../services/gmail/gmail-service';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function gmailController(db: OutreachDb, config: AppConfig) {
  return {
    async start(_request: FastifyRequest, reply: FastifyReply) {
      const url = await beginGoogleAuth(db, config);
      const accept = String(_request.headers.accept || '');
      if (accept.includes('application/json')) return reply.send({ url });
      return reply.redirect(url);
    },
    async callback(request: FastifyRequest, reply: FastifyReply) {
      const query = request.query as { code?: string; state?: string; error?: string };
      if (query.error || !query.code || !query.state) {
        return reply.type('text/html').send(page('Gmail was not connected', escapeHtml(query.error || 'Missing OAuth code')));
      }
      try {
        const account = await completeGoogleAuth(db, config, query.code, query.state);
        return reply.type('text/html').send(page('Gmail connected', `Connected ${escapeHtml(account.email)}. You can close this tab and return to the extension.`));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'OAuth failed';
        return reply.type('text/html').status(400).send(page('Gmail connection failed', escapeHtml(message)));
      }
    },
    async account(_request: FastifyRequest, reply: FastifyReply) {
      return reply.send(await getGmailAccountView(db));
    },
    async disconnect(_request: FastifyRequest, reply: FastifyReply) {
      await disconnectGmail(db);
      return reply.send({ connected: false });
    },
  };
}

function page(title: string, message: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f1012;color:#f2f2f2;display:grid;place-items:center;min-height:100vh;margin:0}main{max-width:520px;padding:28px;background:#17191d;border:1px solid #2a2d33;border-radius:14px}h1{font-size:22px}p{color:#c8cbd0}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${message}</p></main></body></html>`;
}

export function unsubscribeController(db: OutreachDb) {
  return {
    async show(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { token: string };
      const token = String(params.token || '');
      if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
        return reply.type('text/html').status(400).send(page('Invalid link', 'This unsubscribe link is not valid.'));
      }
      const contact = await db.contacts.findByUnsubscribeToken(token);
      if (!contact) {
        return reply.type('text/html').status(404).send(page('Link not found', 'This unsubscribe link is not valid.'));
      }
      const existing = await db.suppressions.findByEmail(contact.normalizedEmail);
      if (!existing) {
        await db.suppressions.create({
          normalizedEmail: contact.normalizedEmail,
          reason: 'UNSUBSCRIBED',
          notes: 'Unsubscribe link',
        });
      }
      if (contact.status !== 'UNSUBSCRIBED') {
        await db.contacts.update(contact.id, { status: 'UNSUBSCRIBED' });
      }
      await db.audit.create({
        eventType: 'SUPPRESSION_ADDED',
        entityType: 'contact',
        entityId: contact.id,
        metadata: { reason: 'UNSUBSCRIBED', normalizedEmail: contact.normalizedEmail },
      });
      return reply.type('text/html').send(page('You are unsubscribed', `${escapeHtml(contact.email)} will not be included in future campaigns.`));
    },
  };
}

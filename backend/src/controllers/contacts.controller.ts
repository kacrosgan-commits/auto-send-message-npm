import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTACT_STATUSES } from '@npm-outreach/shared';
import { OutreachDb } from '../db/types';
import { contactStats, ingestContacts, listContacts } from '../services/contacts/contact-service';
import { parseBody, parseQuery } from '../utils/validate';

const ingestSchema = z.object({
  contacts: z.array(z.object({
    email: z.string().max(320),
    name: z.string().max(200).optional().nullable(),
    packageName: z.string().max(300).optional().nullable(),
    packageUrl: z.string().max(1000).optional().nullable(),
    keyword: z.string().max(200).optional().nullable(),
    role: z.string().max(80).optional().nullable(),
  })).min(1).max(500),
});

const listSchema = z.object({
  status: z.enum(CONTACT_STATUSES).optional(),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  contacted: z.enum(['true', 'false']).optional(),
  suppressed: z.enum(['true', 'false']).optional(),
});

function flag(value: 'true' | 'false' | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function contactsController(db: OutreachDb) {
  return {
    async ingest(request: FastifyRequest, reply: FastifyReply) {
      const body = parseBody(ingestSchema, request.body);
      const result = await ingestContacts(db, body.contacts);
      return reply.send(result);
    },
    async list(request: FastifyRequest, reply: FastifyReply) {
      const query = parseQuery(listSchema, request.query);
      const result = await listContacts(db, {
        status: query.status,
        search: query.search,
        page: query.page,
        limit: query.limit,
        contacted: flag(query.contacted),
        suppressed: flag(query.suppressed),
      });
      return reply.send(result);
    },
    async stats(_request: FastifyRequest, reply: FastifyReply) {
      return reply.send(await contactStats(db));
    },
  };
}

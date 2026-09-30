import { FastifyReply, FastifyRequest } from 'fastify';
import { OutreachDb } from '../db/types.js';
import { parseQuery, pageQuerySchema } from '../utils/validate.js';

export function historyController(db: OutreachDb) {
  return {
    async list(request: FastifyRequest, reply: FastifyReply) {
      const query = parseQuery(pageQuerySchema, request.query);
      const result = await db.recipients.history({ search: query.search, page: query.page, limit: query.limit });
      return reply.send({ page: query.page, limit: query.limit, total: result.total, items: result.items });
    },
  };
}

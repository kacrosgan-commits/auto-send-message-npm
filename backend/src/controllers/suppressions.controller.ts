import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SUPPRESSION_REASONS } from '@npm-outreach/shared';
import { OutreachDb } from '../db/types.js';
import { removeSuppression, suppressEmail } from '../services/suppression/suppression-service.js';
import { parseBody } from '../utils/validate.js';

const createSchema = z.object({
  email: z.string().min(3).max(320),
  reason: z.enum(SUPPRESSION_REASONS),
  notes: z.string().max(1000).nullable().optional(),
});

export function suppressionsController(db: OutreachDb) {
  return {
    async list(_request: FastifyRequest, reply: FastifyReply) {
      return reply.send({ suppressions: await db.suppressions.list() });
    },
    async create(request: FastifyRequest, reply: FastifyReply) {
      const body = parseBody(createSchema, request.body);
      const suppression = await suppressEmail(db, body);
      return reply.status(201).send({ suppression });
    },
    async remove(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { id: string };
      await removeSuppression(db, params.id);
      return reply.status(204).send();
    },
  };
}

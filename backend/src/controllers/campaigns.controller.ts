import { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CONTACT_STATUSES } from '@npm-outreach/shared';
import { AppConfig } from '../config/env.js';
import { OutreachDb } from '../db/types.js';
import { AppError } from '../utils/errors.js';
import { parseBody, parseQuery, pageQuerySchema } from '../utils/validate.js';
import {
  queueCampaign,
  selectCampaignRecipients,
  setCampaignControl,
} from '../services/campaigns/campaign-service.js';

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  subject: z.string().trim().min(1).max(500),
  bodyText: z.string().trim().min(1).max(20000),
  bodyHtml: z.string().max(50000).nullable().optional(),
});

const patchSchema = createSchema.partial();

const recipientSchema = z.object({
  contactIds: z.array(z.string().uuid()).max(5000).optional(),
  filter: z.object({ status: z.enum(CONTACT_STATUSES) }).optional(),
}).refine((value) => Boolean(value.contactIds?.length) || Boolean(value.filter), {
  message: 'Provide contactIds or a filter',
});

export function campaignsController(db: OutreachDb, config: AppConfig, enqueue: (id: string) => Promise<void>) {
  return {
    async create(request: FastifyRequest, reply: FastifyReply) {
      const body = parseBody(createSchema, request.body);
      const campaign = await db.campaigns.create({
        name: body.name,
        subject: body.subject,
        bodyText: body.bodyText,
        bodyHtml: body.bodyHtml ?? null,
      });
      await db.audit.create({
        eventType: 'CAMPAIGN_CREATED',
        entityType: 'campaign',
        entityId: campaign.id,
        metadata: { name: campaign.name },
      });
      return reply.status(201).send({ campaign });
    },
    async list(_request: FastifyRequest, reply: FastifyReply) {
      const campaigns = await db.campaigns.list();
      const withCounts = await Promise.all(campaigns.map(async (campaign) => ({
        ...campaign,
        counts: await db.recipients.countByCampaign(campaign.id),
      })));
      return reply.send({ campaigns: withCounts });
    },
    async get(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { id: string };
      const query = parseQuery(pageQuerySchema, request.query);
      const campaign = await db.campaigns.find(params.id);
      if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      const [counts, recipients] = await Promise.all([
        db.recipients.countByCampaign(campaign.id),
        db.recipients.listCampaignPage(campaign.id, query.page, query.limit),
      ]);
      return reply.send({ campaign, counts, recipients });
    },
    async patch(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { id: string };
      const body = parseBody(patchSchema, request.body ?? {});
      const campaign = await db.campaigns.find(params.id);
      if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      if (campaign.status !== 'DRAFT') {
        throw new AppError(409, 'CAMPAIGN_NOT_EDITABLE', 'Only draft campaigns can be edited');
      }
      const updated = await db.campaigns.update(params.id, {
        name: body.name,
        subject: body.subject,
        bodyText: body.bodyText,
        bodyHtml: body.bodyHtml === undefined ? undefined : body.bodyHtml,
      });
      return reply.send({ campaign: updated });
    },
    async remove(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { id: string };
      const campaign = await db.campaigns.find(params.id);
      if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
      if (campaign.status !== 'DRAFT') {
        throw new AppError(409, 'CAMPAIGN_NOT_EDITABLE', 'Only draft campaigns can be deleted');
      }
      await db.campaigns.delete(params.id);
      return reply.status(204).send();
    },
    async recipients(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { id: string };
      const body = parseBody(recipientSchema, request.body);
      const result = await selectCampaignRecipients(db, params.id, body, config.allowRepeatContact);
      return reply.send(result);
    },
    async queue(request: FastifyRequest, reply: FastifyReply) {
      const params = request.params as { id: string };
      const result = await queueCampaign(db, params.id, config.allowRepeatContact, enqueue);
      return reply.send(result);
    },
    control(action: 'start' | 'pause' | 'resume' | 'cancel') {
      return async (request: FastifyRequest, reply: FastifyReply) => {
        const params = request.params as { id: string };
        const campaign = await setCampaignControl(db, params.id, action, enqueue);
        return reply.send({ campaign });
      };
    },
  };
}

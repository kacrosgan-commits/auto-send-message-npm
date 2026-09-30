import { Prisma, PrismaClient } from '@prisma/client';
import { CampaignStatus, ContactStatus, RecipientStatus, SuppressionReason } from '@npm-outreach/shared';
import {
  AuditRecord,
  CampaignRecord,
  ContactRecord,
  ContactSourceRecord,
  GmailAccountRecord,
  OutreachDb,
  RecipientRecord,
  ReconciliationRecord,
  SuppressionRecord,
} from './types.js';

type DbClient = PrismaClient | Prisma.TransactionClient;

const CONTACT_STATUSES: ContactStatus[] = ['NEW', 'QUEUED', 'CONTACTED', 'BOUNCED', 'INVALID', 'UNSUBSCRIBED', 'BLOCKED'];
const RECIPIENT_STATUSES: RecipientStatus[] = ['PENDING', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED'];

function asRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
  return {};
}

function mapContact(row: {
  id: string;
  email: string;
  normalizedEmail: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string;
  firstDiscoveredAt: Date;
  lastDiscoveredAt: Date;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
  sendCount: number;
  unsubscribeToken: string;
  createdAt: Date;
  updatedAt: Date;
}): ContactRecord {
  return { ...row, status: row.status as ContactStatus };
}

function mapSource(row: ContactSourceRecord): ContactSourceRecord {
  return { ...row };
}

function mapCampaign(row: Omit<CampaignRecord, 'status'> & { status: string }): CampaignRecord {
  return { ...row, status: row.status as CampaignStatus };
}

function mapRecipient(row: (Omit<RecipientRecord, 'status'> & { status: string }) | null): RecipientRecord | null {
  return row ? { ...row, status: row.status as RecipientStatus } : null;
}

function mapSuppression(row: Omit<SuppressionRecord, 'reason'> & { reason: string }): SuppressionRecord {
  return { ...row, reason: row.reason as SuppressionReason };
}

export function createPrismaStore(client: DbClient): OutreachDb {
  const root = '$transaction' in client ? (client as PrismaClient) : null;

  const store: OutreachDb = {
    async transaction(fn) {
      if (!root) return fn(store);
      return root.$transaction((tx) => fn(createPrismaStore(tx)));
    },
    contacts: {
      async findByNormalized(email) {
        const row = await client.contact.findUnique({ where: { normalizedEmail: email } });
        return row ? mapContact(row) : null;
      },
      async findById(id) {
        const row = await client.contact.findUnique({ where: { id } });
        return row ? mapContact(row) : null;
      },
      async findByIds(ids) {
        if (!ids.length) return [];
        const rows = await client.contact.findMany({ where: { id: { in: ids } } });
        return rows.map(mapContact);
      },
      async findByUnsubscribeToken(token) {
        const row = await client.contact.findUnique({ where: { unsubscribeToken: token } });
        return row ? mapContact(row) : null;
      },
      async search(params) {
        const where: Prisma.ContactWhereInput = {};
        const and: Prisma.ContactWhereInput[] = [];
        if (params.status) and.push({ status: params.status });
        if (params.contacted === false) and.push({ firstSentAt: null, status: { not: 'CONTACTED' } });
        if (params.contacted === true) and.push({ OR: [{ firstSentAt: { not: null } }, { status: 'CONTACTED' }] });
        if (params.suppressed === false && params.suppressedEmails && params.suppressedEmails.size > 0) {
          and.push({ normalizedEmail: { notIn: [...params.suppressedEmails] } });
        }
        if (params.suppressed === true) {
          const emails = [...(params.suppressedEmails ?? [])];
          and.push(emails.length ? { normalizedEmail: { in: emails } } : { id: '__none__' });
        }
        if (params.search) {
          and.push({
            OR: [
              { email: { contains: params.search } },
              { name: { contains: params.search } },
              { normalizedEmail: { contains: params.search.toLowerCase() } },
              { sources: { some: { packageName: { contains: params.search } } } },
            ],
          });
        }
        if (and.length) where.AND = and;
        const [total, items] = await Promise.all([
          client.contact.count({ where }),
          client.contact.findMany({
            where,
            orderBy: { lastDiscoveredAt: 'desc' },
            skip: (params.page - 1) * params.limit,
            take: params.limit,
          }),
        ]);
        return { total, items: items.map(mapContact) };
      },
      async create(input) {
        const row = await client.contact.create({
          data: {
            id: input.id,
            email: input.email,
            normalizedEmail: input.normalizedEmail,
            name: input.name,
            firstName: input.firstName,
            lastName: input.lastName,
            status: input.status,
            firstDiscoveredAt: input.firstDiscoveredAt,
            lastDiscoveredAt: input.lastDiscoveredAt,
            firstSentAt: input.firstSentAt,
            lastSentAt: input.lastSentAt,
            sendCount: input.sendCount,
            unsubscribeToken: input.unsubscribeToken,
          },
        });
        return mapContact(row);
      },
      async update(id, patch) {
        const data: Prisma.ContactUpdateInput = {};
        if (patch.email !== undefined) data.email = patch.email;
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.firstName !== undefined) data.firstName = patch.firstName;
        if (patch.lastName !== undefined) data.lastName = patch.lastName;
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.lastDiscoveredAt !== undefined) data.lastDiscoveredAt = patch.lastDiscoveredAt;
        if (patch.firstSentAt !== undefined) data.firstSentAt = patch.firstSentAt;
        if (patch.lastSentAt !== undefined) data.lastSentAt = patch.lastSentAt;
        if (patch.sendCount !== undefined) data.sendCount = patch.sendCount;
        const row = await client.contact.update({ where: { id }, data });
        return mapContact(row);
      },
      async lock(id) {
        const row = await client.contact.findUnique({ where: { id } });
        return row ? mapContact(row) : null;
      },
      async countByStatus() {
        const groups = await client.contact.groupBy({ by: ['status'], _count: { _all: true } });
        const counts = Object.fromEntries(CONTACT_STATUSES.map((status) => [status, 0])) as Record<ContactStatus, number>;
        for (const group of groups) counts[group.status as ContactStatus] = group._count._all;
        return counts;
      },
    },
    sources: {
      async findMatch(contactId, packageName, sourceRole, sourceType) {
        const row = await client.contactSource.findUnique({
          where: { contactId_packageName_sourceRole_sourceType: { contactId, packageName, sourceRole, sourceType } },
        });
        return row ? mapSource(row) : null;
      },
      async create(input) {
        const row = await client.contactSource.create({
          data: {
            contactId: input.contactId,
            sourceType: input.sourceType,
            packageName: input.packageName,
            packageUrl: input.packageUrl,
            npmKeyword: input.npmKeyword,
            sourceRole: input.sourceRole,
            discoveredAt: input.discoveredAt,
          },
        });
        return mapSource(row);
      },
      async listForContact(contactId) {
        const rows = await client.contactSource.findMany({ where: { contactId }, orderBy: { discoveredAt: 'desc' } });
        return rows.map(mapSource);
      },
      async latestForContact(contactId) {
        const row = await client.contactSource.findFirst({ where: { contactId }, orderBy: { discoveredAt: 'desc' } });
        return row ? mapSource(row) : null;
      },
      async latestForContacts(contactIds) {
        const map = new Map<string, ContactSourceRecord>();
        if (!contactIds.length) return map;
        const rows = await client.contactSource.findMany({
          where: { contactId: { in: contactIds } },
          orderBy: { discoveredAt: 'desc' },
        });
        for (const row of rows) {
          if (!map.has(row.contactId)) map.set(row.contactId, mapSource(row));
        }
        return map;
      },
    },
    suppressions: {
      async findByEmail(email) {
        const row = await client.suppression.findUnique({ where: { normalizedEmail: email } });
        return row ? mapSuppression(row) : null;
      },
      async findById(id) {
        const row = await client.suppression.findUnique({ where: { id } });
        return row ? mapSuppression(row) : null;
      },
      async list() {
        const rows = await client.suppression.findMany({ orderBy: { createdAt: 'desc' } });
        return rows.map(mapSuppression);
      },
      async create(input) {
        const row = await client.suppression.create({
          data: {
            normalizedEmail: input.normalizedEmail,
            reason: input.reason,
            notes: input.notes,
          },
        });
        return mapSuppression(row);
      },
      async delete(id) {
        await client.suppression.delete({ where: { id } });
      },
      async emails() {
        const rows = await client.suppression.findMany({ select: { normalizedEmail: true } });
        return new Set(rows.map((row) => row.normalizedEmail));
      },
      async count() {
        return client.suppression.count();
      },
    },
    campaigns: {
      async create(input) {
        const row = await client.campaign.create({
          data: {
            name: input.name,
            subject: input.subject,
            bodyText: input.bodyText,
            bodyHtml: input.bodyHtml ?? null,
            status: input.status ?? 'DRAFT',
          },
        });
        return mapCampaign(row);
      },
      async list() {
        const rows = await client.campaign.findMany({ orderBy: { createdAt: 'desc' } });
        return rows.map(mapCampaign);
      },
      async find(id) {
        const row = await client.campaign.findUnique({ where: { id } });
        return row ? mapCampaign(row) : null;
      },
      async update(id, patch) {
        const data: Prisma.CampaignUpdateInput = {};
        if (patch.name !== undefined) data.name = patch.name;
        if (patch.subject !== undefined) data.subject = patch.subject;
        if (patch.bodyText !== undefined) data.bodyText = patch.bodyText;
        if (patch.bodyHtml !== undefined) data.bodyHtml = patch.bodyHtml;
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.startedAt !== undefined) data.startedAt = patch.startedAt;
        if (patch.pausedAt !== undefined) data.pausedAt = patch.pausedAt;
        if (patch.completedAt !== undefined) data.completedAt = patch.completedAt;
        const row = await client.campaign.update({ where: { id }, data });
        return mapCampaign(row);
      },
      async delete(id) {
        await client.campaign.delete({ where: { id } });
      },
    },
    recipients: {
      async find(id) {
        return mapRecipient(await client.campaignRecipient.findUnique({ where: { id } }));
      },
      async lock(id) {
        return mapRecipient(await client.campaignRecipient.findUnique({ where: { id } }));
      },
      async findByCampaignContact(campaignId, contactId) {
        return mapRecipient(await client.campaignRecipient.findUnique({
          where: { campaignId_contactId: { campaignId, contactId } },
        }));
      },
      async listByCampaign(campaignId) {
        const rows = await client.campaignRecipient.findMany({ where: { campaignId } });
        return rows.map((row) => mapRecipient(row) as RecipientRecord);
      },
      async create(input) {
        const row = await client.campaignRecipient.create({
          data: {
            campaignId: input.campaignId,
            contactId: input.contactId,
            status: input.status ?? 'PENDING',
            scheduledAt: input.scheduledAt ?? null,
          },
        });
        return mapRecipient(row) as RecipientRecord;
      },
      async update(id, patch) {
        const data: Prisma.CampaignRecipientUpdateInput = {};
        if (patch.status !== undefined) data.status = patch.status;
        if (patch.scheduledAt !== undefined) data.scheduledAt = patch.scheduledAt;
        if (patch.sentAt !== undefined) data.sentAt = patch.sentAt;
        if (patch.attempts !== undefined) data.attempts = patch.attempts;
        if (patch.gmailMessageId !== undefined) data.gmailMessageId = patch.gmailMessageId;
        if (patch.gmailThreadId !== undefined) data.gmailThreadId = patch.gmailThreadId;
        if (patch.lastError !== undefined) data.lastError = patch.lastError;
        const row = await client.campaignRecipient.update({ where: { id }, data });
        return mapRecipient(row) as RecipientRecord;
      },
      async countByCampaign(campaignId) {
        const groups = await client.campaignRecipient.groupBy({
          by: ['status'],
          where: { campaignId },
          _count: { _all: true },
        });
        const counts = Object.fromEntries(RECIPIENT_STATUSES.map((status) => [status, 0])) as Record<RecipientStatus, number>;
        for (const group of groups) counts[group.status as RecipientStatus] = group._count._all;
        return counts;
      },
      async sendWindow(now) {
        const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
        const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        const [sentLastHour, sentLastDay, latest, oldest] = await Promise.all([
          client.campaignRecipient.count({ where: { status: 'SENT', sentAt: { gte: hourAgo } } }),
          client.campaignRecipient.count({ where: { status: 'SENT', sentAt: { gte: dayAgo } } }),
          client.campaignRecipient.findFirst({ where: { status: 'SENT', sentAt: { not: null } }, orderBy: { sentAt: 'desc' } }),
          client.campaignRecipient.findFirst({ where: { status: 'SENT', sentAt: { gte: hourAgo } }, orderBy: { sentAt: 'asc' } }),
        ]);
        return {
          sentLastHour,
          sentLastDay,
          lastSentAt: latest?.sentAt ?? null,
          oldestSentLastHour: oldest?.sentAt ?? null,
        };
      },
      async history(params) {
        const where: Prisma.CampaignRecipientWhereInput = {
          status: { in: ['SENT', 'FAILED', 'SKIPPED', 'CANCELLED'] },
        };
        if (params.search) {
          where.OR = [
            { contact: { email: { contains: params.search } } },
            { contact: { name: { contains: params.search } } },
            { campaign: { name: { contains: params.search } } },
            { gmailMessageId: { contains: params.search } },
            { contact: { sources: { some: { packageName: { contains: params.search } } } } },
          ];
        }
        const [total, rows] = await Promise.all([
          client.campaignRecipient.count({ where }),
          client.campaignRecipient.findMany({
            where,
            include: {
              contact: { include: { sources: { orderBy: { discoveredAt: 'desc' }, take: 1 } } },
              campaign: true,
            },
            orderBy: { sentAt: 'desc' },
            skip: (params.page - 1) * params.limit,
            take: params.limit,
          }),
        ]);
        return {
          total,
          items: rows.map((row) => ({
            recipientId: row.id,
            email: row.contact.email,
            name: row.contact.name,
            campaignId: row.campaignId,
            campaignName: row.campaign.name,
            packageName: row.contact.sources[0]?.packageName ?? null,
            sentAt: row.sentAt,
            gmailMessageId: row.gmailMessageId,
            status: row.status as RecipientStatus,
            lastError: row.lastError,
          })),
        };
      },
      async listCampaignPage(campaignId, page, limit) {
        const where = { campaignId };
        const [total, rows] = await Promise.all([
          client.campaignRecipient.count({ where }),
          client.campaignRecipient.findMany({
            where,
            include: { contact: { include: { sources: { orderBy: { discoveredAt: 'desc' }, take: 1 } } } },
            orderBy: { updatedAt: 'desc' },
            skip: (page - 1) * limit,
            take: limit,
          }),
        ]);
        return {
          total,
          items: rows.map((row) => ({
            ...(mapRecipient(row) as RecipientRecord),
            email: row.contact.email,
            name: row.contact.name,
            packageName: row.contact.sources[0]?.packageName ?? null,
          })),
        };
      },
    },
    audit: {
      async create(event) {
        const row = await client.auditLog.create({
          data: {
            eventType: event.eventType,
            entityType: event.entityType,
            entityId: event.entityId ?? null,
            metadata: JSON.stringify(event.metadata ?? {}),
          },
        });
        const record: AuditRecord = {
          id: row.id,
          eventType: row.eventType,
          entityType: row.entityType,
          entityId: row.entityId,
          metadata: asRecord(row.metadata),
          createdAt: row.createdAt,
        };
        return record;
      },
      async list() {
        const rows = await client.auditLog.findMany({ orderBy: { createdAt: 'asc' } });
        return rows.map((row) => ({
          id: row.id,
          eventType: row.eventType,
          entityType: row.entityType,
          entityId: row.entityId,
          metadata: asRecord(row.metadata),
          createdAt: row.createdAt,
        }));
      },
    },
    gmailAccounts: {
      async getActive() {
        const row = await client.gmailAccount.findFirst({
          where: { isActive: true, NOT: { encryptedRefreshToken: '' } },
          orderBy: { updatedAt: 'desc' },
        });
        return row ? mapAccount(row) : null;
      },
      async upsert(input) {
        await client.gmailAccount.updateMany({ data: { isActive: false } });
        const row = await client.gmailAccount.upsert({
          where: { googleAccountId: input.googleAccountId },
          create: {
            email: input.email,
            googleAccountId: input.googleAccountId,
            encryptedRefreshToken: input.encryptedRefreshToken,
            scopes: input.scopes,
            isActive: true,
          },
          update: {
            email: input.email,
            encryptedRefreshToken: input.encryptedRefreshToken,
            scopes: input.scopes,
            isActive: true,
          },
        });
        return mapAccount(row);
      },
      async deactivate() {
        await client.gmailAccount.updateMany({
          where: { isActive: true },
          data: { isActive: false, encryptedRefreshToken: '' },
        });
      },
    },
    oauthStates: {
      async create(state, expiresAt) {
        await client.oauthState.create({ data: { state, expiresAt } });
      },
      async consume(state, now) {
        const row = await client.oauthState.findUnique({ where: { state } });
        if (!row || row.expiresAt.getTime() < now.getTime()) return false;
        await client.oauthState.delete({ where: { id: row.id } });
        return true;
      },
    },
    reconciliations: {
      async create(input) {
        const row = await client.sendReconciliation.upsert({
          where: { campaignRecipientId: input.campaignRecipientId },
          create: {
            campaignRecipientId: input.campaignRecipientId,
            gmailMessageId: input.gmailMessageId,
            gmailThreadId: input.gmailThreadId,
            normalizedEmail: input.normalizedEmail,
            error: input.error,
            resolved: false,
          },
          update: {
            gmailMessageId: input.gmailMessageId,
            gmailThreadId: input.gmailThreadId,
            error: input.error,
            resolved: false,
          },
        });
        return mapReconciliation(row);
      },
      async findByRecipient(campaignRecipientId) {
        const row = await client.sendReconciliation.findUnique({ where: { campaignRecipientId } });
        return row ? mapReconciliation(row) : null;
      },
      async markResolved(campaignRecipientId) {
        await client.sendReconciliation.updateMany({ where: { campaignRecipientId }, data: { resolved: true } });
      },
    },
  };

  return store;
}

function mapAccount(row: GmailAccountRecord): GmailAccountRecord {
  return { ...row };
}

function mapReconciliation(row: ReconciliationRecord): ReconciliationRecord {
  return { ...row };
}

export function createPrismaClient(): PrismaClient {
  return new PrismaClient();
}

export async function prepareDatabase(prisma: PrismaClient): Promise<void> {
  await prisma.$queryRawUnsafe('PRAGMA journal_mode = WAL');
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout = 5000');
}

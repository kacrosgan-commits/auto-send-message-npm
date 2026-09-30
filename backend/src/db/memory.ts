import { randomUUID } from 'crypto';
import { CampaignStatus, ContactStatus, RecipientStatus } from '@npm-outreach/shared';
import { UniqueViolation } from '../utils/errors.js';
import {
  AuditRecord,
  CampaignRecord,
  ContactRecord,
  ContactSearchParams,
  ContactSourceRecord,
  GmailAccountRecord,
  HistoryRow,
  OutreachDb,
  RecipientRecord,
  ReconciliationRecord,
  SendWindowStats,
  SuppressionRecord,
} from './types.js';

interface MemoryData {
  contacts: ContactRecord[];
  sources: ContactSourceRecord[];
  campaigns: CampaignRecord[];
  recipients: RecipientRecord[];
  suppressions: SuppressionRecord[];
  audits: AuditRecord[];
  gmailAccounts: GmailAccountRecord[];
  oauthStates: Array<{ state: string; expiresAt: Date; used: boolean }>;
  reconciliations: ReconciliationRecord[];
}

const CONTACT_STATUSES: ContactStatus[] = ['NEW', 'QUEUED', 'CONTACTED', 'BOUNCED', 'INVALID', 'UNSUBSCRIBED', 'BLOCKED'];
const RECIPIENT_STATUSES: RecipientStatus[] = ['PENDING', 'QUEUED', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED', 'CANCELLED'];

function clone<T>(value: T): T {
  return structuredClone(value);
}

function assignDefined<T extends object>(target: T, patch: Partial<T>): void {
  for (const [key, value] of Object.entries(patch) as Array<[keyof T, T[keyof T]]>) {
    if (value !== undefined) target[key] = value;
  }
}

export function createMemoryDb(): OutreachDb {
  const data: MemoryData = {
    contacts: [],
    sources: [],
    campaigns: [],
    recipients: [],
    suppressions: [],
    audits: [],
    gmailAccounts: [],
    oauthStates: [],
    reconciliations: [],
  };
  let inTx = false;

  const db: OutreachDb = {
    async transaction(fn) {
      if (inTx) return fn(db);
      inTx = true;
      const snapshot = clone(data);
      try {
        return await fn(db);
      } catch (error) {
        data.contacts = snapshot.contacts;
        data.sources = snapshot.sources;
        data.campaigns = snapshot.campaigns;
        data.recipients = snapshot.recipients;
        data.suppressions = snapshot.suppressions;
        data.audits = snapshot.audits;
        data.gmailAccounts = snapshot.gmailAccounts;
        data.oauthStates = snapshot.oauthStates;
        data.reconciliations = snapshot.reconciliations;
        throw error;
      } finally {
        inTx = false;
      }
    },
    contacts: {
      async findByNormalized(email) {
        return data.contacts.find((contact) => contact.normalizedEmail === email) ?? null;
      },
      async findById(id) {
        return data.contacts.find((contact) => contact.id === id) ?? null;
      },
      async findByIds(ids) {
        const wanted = new Set(ids);
        return data.contacts.filter((contact) => wanted.has(contact.id));
      },
      async findByUnsubscribeToken(token) {
        return data.contacts.find((contact) => contact.unsubscribeToken === token) ?? null;
      },
      async search(params: ContactSearchParams) {
        const suppressed = params.suppressedEmails ?? new Set(data.suppressions.map((row) => row.normalizedEmail));
        let rows = data.contacts.slice();
        if (params.status) rows = rows.filter((row) => row.status === params.status);
        if (params.contacted === false) rows = rows.filter((row) => !row.firstSentAt && row.status !== 'CONTACTED');
        if (params.contacted === true) rows = rows.filter((row) => Boolean(row.firstSentAt) || row.status === 'CONTACTED');
        if (params.suppressed === false) rows = rows.filter((row) => !suppressed.has(row.normalizedEmail));
        if (params.suppressed === true) rows = rows.filter((row) => suppressed.has(row.normalizedEmail));
        if (params.search) {
          const q = params.search.toLowerCase();
          rows = rows.filter((row) => {
            const sources = data.sources.filter((source) => source.contactId === row.id);
            return row.email.toLowerCase().includes(q) ||
              (row.name || '').toLowerCase().includes(q) ||
              sources.some((source) => source.packageName.toLowerCase().includes(q));
          });
        }
        rows.sort((a, b) => b.lastDiscoveredAt.getTime() - a.lastDiscoveredAt.getTime());
        const total = rows.length;
        const start = (params.page - 1) * params.limit;
        return { items: rows.slice(start, start + params.limit), total };
      },
      async create(input) {
        if (data.contacts.some((contact) => contact.normalizedEmail === input.normalizedEmail)) {
          throw new UniqueViolation('normalizedEmail');
        }
        const now = new Date();
        const contact: ContactRecord = {
          ...input,
          createdAt: input.createdAt ?? now,
          updatedAt: input.updatedAt ?? now,
        };
        data.contacts.push(contact);
        return contact;
      },
      async update(id, patch) {
        const contact = data.contacts.find((row) => row.id === id);
        if (!contact) throw new Error(`Contact ${id} not found`);
        assignDefined(contact, patch);
        contact.updatedAt = new Date();
        return contact;
      },
      async lock(id) {
        return data.contacts.find((contact) => contact.id === id) ?? null;
      },
      async countByStatus() {
        const counts = Object.fromEntries(CONTACT_STATUSES.map((status) => [status, 0])) as Record<ContactStatus, number>;
        for (const contact of data.contacts) counts[contact.status] += 1;
        return counts;
      },
    },
    sources: {
      async findMatch(contactId, packageName, sourceRole, sourceType) {
        return data.sources.find((source) =>
          source.contactId === contactId &&
          source.packageName === packageName &&
          source.sourceRole === sourceRole &&
          source.sourceType === sourceType) ?? null;
      },
      async create(input) {
        if (data.sources.some((source) =>
          source.contactId === input.contactId &&
          source.packageName === input.packageName &&
          source.sourceRole === input.sourceRole &&
          source.sourceType === input.sourceType)) {
          throw new UniqueViolation('contact source');
        }
        const source: ContactSourceRecord = {
          id: input.id ?? randomUUID(),
          discoveredAt: input.discoveredAt ?? new Date(),
          contactId: input.contactId,
          sourceType: input.sourceType,
          packageName: input.packageName,
          packageUrl: input.packageUrl,
          npmKeyword: input.npmKeyword,
          sourceRole: input.sourceRole,
        };
        data.sources.push(source);
        return source;
      },
      async listForContact(contactId) {
        return data.sources
          .filter((source) => source.contactId === contactId)
          .sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime());
      },
      async latestForContact(contactId) {
        const list = await this.listForContact(contactId);
        return list[0] ?? null;
      },
      async latestForContacts(contactIds) {
        const map = new Map<string, ContactSourceRecord>();
        for (const id of contactIds) {
          const latest = await this.latestForContact(id);
          if (latest) map.set(id, latest);
        }
        return map;
      },
    },
    suppressions: {
      async findByEmail(email) {
        return data.suppressions.find((row) => row.normalizedEmail === email) ?? null;
      },
      async findById(id) {
        return data.suppressions.find((row) => row.id === id) ?? null;
      },
      async list() {
        return data.suppressions.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async create(input) {
        if (data.suppressions.some((row) => row.normalizedEmail === input.normalizedEmail)) {
          throw new UniqueViolation('suppression');
        }
        const row: SuppressionRecord = {
          id: input.id ?? randomUUID(),
          createdAt: input.createdAt ?? new Date(),
          normalizedEmail: input.normalizedEmail,
          reason: input.reason,
          notes: input.notes,
        };
        data.suppressions.push(row);
        return row;
      },
      async delete(id) {
        const index = data.suppressions.findIndex((row) => row.id === id);
        if (index >= 0) data.suppressions.splice(index, 1);
      },
      async emails() {
        return new Set(data.suppressions.map((row) => row.normalizedEmail));
      },
      async count() {
        return data.suppressions.length;
      },
    },
    campaigns: {
      async create(input) {
        const now = new Date();
        const campaign: CampaignRecord = {
          id: input.id ?? randomUUID(),
          name: input.name,
          subject: input.subject,
          bodyText: input.bodyText,
          bodyHtml: input.bodyHtml,
          status: input.status ?? 'DRAFT',
          createdAt: now,
          startedAt: null,
          pausedAt: null,
          completedAt: null,
        };
        data.campaigns.push(campaign);
        return campaign;
      },
      async list() {
        return data.campaigns.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async find(id) {
        return data.campaigns.find((campaign) => campaign.id === id) ?? null;
      },
      async update(id, patch) {
        const campaign = data.campaigns.find((row) => row.id === id);
        if (!campaign) throw new Error(`Campaign ${id} not found`);
        assignDefined(campaign, patch);
        return campaign;
      },
      async delete(id) {
        const index = data.campaigns.findIndex((row) => row.id === id);
        if (index >= 0) data.campaigns.splice(index, 1);
        data.recipients = data.recipients.filter((row) => row.campaignId !== id);
      },
    },
    recipients: {
      async find(id) {
        return data.recipients.find((row) => row.id === id) ?? null;
      },
      async lock(id) {
        return data.recipients.find((row) => row.id === id) ?? null;
      },
      async findByCampaignContact(campaignId, contactId) {
        return data.recipients.find((row) => row.campaignId === campaignId && row.contactId === contactId) ?? null;
      },
      async listByCampaign(campaignId) {
        return data.recipients.filter((row) => row.campaignId === campaignId);
      },
      async create(input) {
        if (data.recipients.some((row) => row.campaignId === input.campaignId && row.contactId === input.contactId)) {
          throw new UniqueViolation('campaign recipient');
        }
        const now = new Date();
        const row: RecipientRecord = {
          id: randomUUID(),
          campaignId: input.campaignId,
          contactId: input.contactId,
          status: input.status ?? 'PENDING',
          scheduledAt: input.scheduledAt ?? null,
          sentAt: null,
          attempts: 0,
          gmailMessageId: null,
          gmailThreadId: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        };
        data.recipients.push(row);
        return row;
      },
      async update(id, patch) {
        const row = data.recipients.find((item) => item.id === id);
        if (!row) throw new Error(`Recipient ${id} not found`);
        assignDefined(row, patch);
        row.updatedAt = new Date();
        return row;
      },
      async countByCampaign(campaignId) {
        const counts = Object.fromEntries(RECIPIENT_STATUSES.map((status) => [status, 0])) as Record<RecipientStatus, number>;
        for (const row of data.recipients) {
          if (row.campaignId === campaignId) counts[row.status] += 1;
        }
        return counts;
      },
      async sendWindow(now) {
        const hourAgo = now.getTime() - 60 * 60 * 1000;
        const dayAgo = now.getTime() - 24 * 60 * 60 * 1000;
        const sent = data.recipients.filter((row) => row.status === 'SENT' && row.sentAt);
        const lastHour = sent.filter((row) => (row.sentAt as Date).getTime() >= hourAgo);
        const lastDay = sent.filter((row) => (row.sentAt as Date).getTime() >= dayAgo);
        const lastSentAt = sent.reduce<Date | null>((latest, row) => {
          const sentAt = row.sentAt as Date;
          if (!latest || sentAt > latest) return sentAt;
          return latest;
        }, null);
        const oldestSentLastHour = lastHour.reduce<Date | null>((oldest, row) => {
          const sentAt = row.sentAt as Date;
          if (!oldest || sentAt < oldest) return sentAt;
          return oldest;
        }, null);
        const stats: SendWindowStats = {
          sentLastHour: lastHour.length,
          sentLastDay: lastDay.length,
          lastSentAt,
          oldestSentLastHour,
        };
        return stats;
      },
      async history(params) {
        const rows = data.recipients.filter((row) => ['SENT', 'FAILED', 'SKIPPED', 'CANCELLED'].includes(row.status));
        const mapped: HistoryRow[] = [];
        for (const row of rows) {
          const contact = data.contacts.find((item) => item.id === row.contactId);
          const campaign = data.campaigns.find((item) => item.id === row.campaignId);
          const source = data.sources
            .filter((item) => item.contactId === row.contactId)
            .sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())[0];
          if (!contact || !campaign) continue;
          mapped.push({
            recipientId: row.id,
            email: contact.email,
            name: contact.name,
            campaignId: campaign.id,
            campaignName: campaign.name,
            packageName: source?.packageName ?? null,
            sentAt: row.sentAt,
            gmailMessageId: row.gmailMessageId,
            status: row.status,
            lastError: row.lastError,
          });
        }
        const q = params.search?.toLowerCase();
        const filtered = q
          ? mapped.filter((row) =>
            row.email.toLowerCase().includes(q) ||
            row.campaignName.toLowerCase().includes(q) ||
            (row.packageName || '').toLowerCase().includes(q) ||
            (row.gmailMessageId || '').toLowerCase().includes(q))
          : mapped;
        filtered.sort((a, b) => (b.sentAt?.getTime() || 0) - (a.sentAt?.getTime() || 0));
        const start = (params.page - 1) * params.limit;
        return { items: filtered.slice(start, start + params.limit), total: filtered.length };
      },
      async listCampaignPage(campaignId, page, limit) {
        const rows = data.recipients
          .filter((row) => row.campaignId === campaignId)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        const total = rows.length;
        const start = (page - 1) * limit;
        const items = rows.slice(start, start + limit).map((row) => {
          const contact = data.contacts.find((item) => item.id === row.contactId);
          const source = data.sources
            .filter((item) => item.contactId === row.contactId)
            .sort((a, b) => b.discoveredAt.getTime() - a.discoveredAt.getTime())[0];
          return {
            ...row,
            email: contact?.email || '',
            name: contact?.name ?? null,
            packageName: source?.packageName ?? null,
          };
        });
        return { items, total };
      },
    },
    audit: {
      async create(event) {
        const row: AuditRecord = {
          id: randomUUID(),
          eventType: event.eventType,
          entityType: event.entityType,
          entityId: event.entityId ?? null,
          metadata: event.metadata ?? {},
          createdAt: new Date(),
        };
        data.audits.push(row);
        return row;
      },
      async list() {
        return data.audits.slice();
      },
    },
    gmailAccounts: {
      async getActive() {
        return data.gmailAccounts.find((account) => account.isActive && account.encryptedRefreshToken) ?? null;
      },
      async upsert(input) {
        const now = new Date();
        for (const account of data.gmailAccounts) account.isActive = false;
        const existing = data.gmailAccounts.find((account) => account.googleAccountId === input.googleAccountId);
        if (existing) {
          existing.email = input.email;
          existing.encryptedRefreshToken = input.encryptedRefreshToken;
          existing.scopes = input.scopes;
          existing.isActive = true;
          existing.updatedAt = now;
          return existing;
        }
        const created: GmailAccountRecord = {
          id: randomUUID(),
          email: input.email,
          googleAccountId: input.googleAccountId,
          encryptedRefreshToken: input.encryptedRefreshToken,
          scopes: input.scopes,
          connectedAt: now,
          updatedAt: now,
          isActive: true,
        };
        data.gmailAccounts.push(created);
        return created;
      },
      async deactivate() {
        const now = new Date();
        for (const account of data.gmailAccounts) {
          if (account.isActive) {
            account.isActive = false;
            account.encryptedRefreshToken = '';
            account.updatedAt = now;
          }
        }
      },
    },
    oauthStates: {
      async create(state, expiresAt) {
        data.oauthStates.push({ state, expiresAt, used: false });
      },
      async consume(state, now) {
        const row = data.oauthStates.find((item) => item.state === state && !item.used);
        if (!row || row.expiresAt.getTime() < now.getTime()) return false;
        row.used = true;
        return true;
      },
    },
    reconciliations: {
      async create(input) {
        const row: ReconciliationRecord = {
          id: randomUUID(),
          campaignRecipientId: input.campaignRecipientId,
          gmailMessageId: input.gmailMessageId,
          gmailThreadId: input.gmailThreadId,
          normalizedEmail: input.normalizedEmail,
          error: input.error,
          resolved: input.resolved ?? false,
          createdAt: new Date(),
        };
        data.reconciliations.push(row);
        return row;
      },
      async findByRecipient(campaignRecipientId) {
        return data.reconciliations.find((row) => row.campaignRecipientId === campaignRecipientId) ?? null;
      },
      async markResolved(campaignRecipientId) {
        const row = data.reconciliations.find((item) => item.campaignRecipientId === campaignRecipientId);
        if (row) row.resolved = true;
      },
    },
  };

  return db;
}

export function emptyStatusCounts(): Record<CampaignStatus, number> {
  return { DRAFT: 0, QUEUED: 0, RUNNING: 0, PAUSED: 0, COMPLETED: 0, CANCELLED: 0 };
}

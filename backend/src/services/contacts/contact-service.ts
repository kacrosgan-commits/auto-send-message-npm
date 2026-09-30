import { randomUUID } from 'crypto';
import {
  CONTACT_STATUSES,
  ContactStatus,
  Eligibility,
  IngestContactInput,
  IngestResponse,
  isNoreplyAddress,
  isValidEmail,
  normalizeEmail,
  normalizeRole,
  splitName,
  SuppressionReason,
} from '@npm-outreach/shared';
import { SuppressionRecord } from '../../db/types.js';
import { OutreachDb } from '../../db/types.js';
import { isUniqueViolation } from '../../utils/errors.js';
import { randomToken } from '../../utils/crypto.js';

function statusForSuppression(reason: SuppressionReason): ContactStatus {
  if (reason === 'UNSUBSCRIBED') return 'UNSUBSCRIBED';
  if (reason === 'INVALID') return 'INVALID';
  if (reason === 'HARD_BOUNCE') return 'BOUNCED';
  if (reason === 'ALREADY_CONTACTED') return 'CONTACTED';
  return 'BLOCKED';
}

function eligibilityForExisting(
  status: ContactStatus,
  suppression: SuppressionRecord | null,
  previouslySent: boolean,
): Eligibility {
  if (status === 'INVALID') return 'INVALID';
  if (previouslySent || status === 'CONTACTED' || suppression?.reason === 'ALREADY_CONTACTED') return 'ALREADY_CONTACTED';
  if (suppression || status === 'UNSUBSCRIBED' || status === 'BLOCKED' || status === 'BOUNCED') return 'SUPPRESSED';
  return 'NEW';
}

export async function ingestContacts(db: OutreachDb, inputs: IngestContactInput[]): Promise<IngestResponse> {
  const summary = { received: inputs.length, new: 0, alreadyContacted: 0, suppressed: 0, invalid: 0 };
  const contacts: IngestResponse['contacts'] = [];

  for (const input of inputs) {
    const normalized = normalizeEmail(input.email || '');
    const displayEmail = String(input.email || '').trim();
    if (!isValidEmail(normalized) || isNoreplyAddress(normalized)) {
      summary.invalid += 1;
      contacts.push({
        email: displayEmail,
        normalizedEmail: normalized,
        eligibility: 'INVALID',
        reason: isNoreplyAddress(normalized) ? 'Noreply or automated address' : 'Invalid email syntax',
      });
      await db.audit.create({
        eventType: 'CONTACT_SKIPPED',
        entityType: 'contact',
        metadata: { normalizedEmail: normalized, reason: 'invalid' },
      });
      continue;
    }

    const suppression = await db.suppressions.findByEmail(normalized);
    const now = new Date();
    const parsedName = splitName(input.name);
    let contact = await db.contacts.findByNormalized(normalized);
    let created = false;

    if (!contact) {
      try {
        contact = await db.contacts.create({
          id: randomUUID(),
          email: displayEmail,
          normalizedEmail: normalized,
          name: input.name?.trim() || null,
          firstName: parsedName.firstName,
          lastName: parsedName.lastName,
          status: suppression ? statusForSuppression(suppression.reason) : 'NEW',
          firstDiscoveredAt: now,
          lastDiscoveredAt: now,
          firstSentAt: null,
          lastSentAt: null,
          sendCount: 0,
          unsubscribeToken: randomToken(32),
        });
        created = true;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        contact = await db.contacts.findByNormalized(normalized);
      }
    }

    if (!contact) throw new Error('Contact upsert failed');

    if (!created) {
      const patch: Partial<typeof contact> = { lastDiscoveredAt: now };
      if (!contact.name && input.name?.trim()) {
        patch.name = input.name.trim();
        patch.firstName = parsedName.firstName;
        patch.lastName = parsedName.lastName;
      }
      if (suppression && (contact.status === 'NEW' || contact.status === 'QUEUED')) {
        patch.status = statusForSuppression(suppression.reason);
      }
      contact = await db.contacts.update(contact.id, patch);
    }

    const role = normalizeRole(input.role);
    const packageName = String(input.packageName || '').trim();
    const existingSource = await db.sources.findMatch(contact.id, packageName, role, 'npm');
    if (!existingSource) {
      try {
        await db.sources.create({
          contactId: contact.id,
          sourceType: 'npm',
          packageName,
          packageUrl: input.packageUrl?.trim() || null,
          npmKeyword: input.keyword?.trim() || null,
          sourceRole: role,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }

    const previouslySent = Boolean(contact.firstSentAt) || contact.sendCount > 0 || contact.status === 'CONTACTED';
    const eligibility = eligibilityForExisting(contact.status, suppression, previouslySent);
    if (eligibility === 'NEW') summary.new += 1;
    else if (eligibility === 'ALREADY_CONTACTED') summary.alreadyContacted += 1;
    else if (eligibility === 'SUPPRESSED') summary.suppressed += 1;
    else summary.invalid += 1;

    await db.audit.create({
      eventType: 'CONTACT_DISCOVERED',
      entityType: 'contact',
      entityId: contact.id,
      metadata: {
        normalizedEmail: normalized,
        packageName,
        role,
        eligibility,
      },
    });

    contacts.push({
      email: contact.email,
      normalizedEmail: contact.normalizedEmail,
      eligibility,
      contactId: contact.id,
      status: contact.status,
      name: contact.name,
      packageName: packageName || null,
      role,
      reason: suppression ? suppression.reason : undefined,
    });
  }

  return { summary, contacts };
}

export async function contactStats(db: OutreachDb) {
  const [counts, suppressed] = await Promise.all([
    db.contacts.countByStatus(),
    db.suppressions.count(),
  ]);
  const totalContacts = CONTACT_STATUSES.reduce((sum, status) => sum + counts[status], 0);
  return {
    totalContacts,
    newContacts: counts.NEW,
    contacted: counts.CONTACTED,
    queued: counts.QUEUED,
    suppressed,
    bounced: counts.BOUNCED,
    invalid: counts.INVALID,
  };
}

export interface ContactListQuery {
  status?: ContactStatus;
  search?: string;
  page: number;
  limit: number;
  contacted?: boolean;
  suppressed?: boolean;
}

export async function listContacts(db: OutreachDb, query: ContactListQuery) {
  const suppressedEmails = await db.suppressions.emails();
  const page = await db.contacts.search({ ...query, suppressedEmails });
  const sources = await db.sources.latestForContacts(page.items.map((item) => item.id));
  return {
    page: query.page,
    limit: query.limit,
    total: page.total,
    contacts: page.items.map((contact) => {
      const source = sources.get(contact.id);
      return {
        id: contact.id,
        email: contact.email,
        normalizedEmail: contact.normalizedEmail,
        name: contact.name,
        firstName: contact.firstName,
        lastName: contact.lastName,
        status: contact.status,
        firstDiscoveredAt: contact.firstDiscoveredAt,
        lastDiscoveredAt: contact.lastDiscoveredAt,
        firstSentAt: contact.firstSentAt,
        lastSentAt: contact.lastSentAt,
        sendCount: contact.sendCount,
        packageName: source?.packageName ?? null,
        packageUrl: source?.packageUrl ?? null,
        sourceRole: source?.sourceRole ?? null,
        keyword: source?.npmKeyword ?? null,
        suppressed: suppressedEmails.has(contact.normalizedEmail),
      };
    }),
  };
}

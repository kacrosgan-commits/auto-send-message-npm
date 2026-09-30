import {
  ContactStatus,
  isValidEmail,
  RecipientSelectionResult,
  SuppressionReason,
} from '@npm-outreach/shared';
import { ContactRecord, OutreachDb } from '../../db/types.js';
import { AppError, isUniqueViolation } from '../../utils/errors.js';

export type QueueClass = 'eligible' | 'alreadyContacted' | 'suppressed' | 'invalid' | 'alreadyQueued';

export function classifyForQueue(input: {
  contact: Pick<ContactRecord, 'status' | 'firstSentAt' | 'sendCount' | 'normalizedEmail'>;
  suppressionReason: SuppressionReason | null;
  existingOnCampaign: boolean;
  allowRepeatContact: boolean;
}): QueueClass {
  if (input.existingOnCampaign) return 'alreadyQueued';
  if (!isValidEmail(input.contact.normalizedEmail) || input.contact.status === 'INVALID') return 'invalid';
  const previouslySent = Boolean(input.contact.firstSentAt)
    || input.contact.sendCount > 0
    || input.contact.status === 'CONTACTED'
    || input.suppressionReason === 'ALREADY_CONTACTED';
  if (previouslySent && !input.allowRepeatContact) return 'alreadyContacted';
  if (
    input.suppressionReason ||
    input.contact.status === 'UNSUBSCRIBED' ||
    input.contact.status === 'BLOCKED' ||
    input.contact.status === 'BOUNCED'
  ) {
    return 'suppressed';
  }
  if (input.contact.status === 'QUEUED') return 'alreadyQueued';
  if (input.contact.status !== 'NEW' && !(input.allowRepeatContact && previouslySent)) return 'alreadyContacted';
  return 'eligible';
}

async function loadSelection(db: OutreachDb, input: { contactIds?: string[]; filter?: { status?: ContactStatus } }): Promise<ContactRecord[]> {
  if (input.contactIds?.length) {
    const contacts = await db.contacts.findByIds(input.contactIds);
    const byId = new Map(contacts.map((contact) => [contact.id, contact]));
    return input.contactIds.map((id) => byId.get(id)).filter((contact): contact is ContactRecord => Boolean(contact));
  }
  const status = input.filter?.status ?? 'NEW';
  const collected: ContactRecord[] = [];
  const pageSize = 200;
  let page = 1;
  for (;;) {
    const result = await db.contacts.search({ status, page, limit: pageSize });
    collected.push(...result.items);
    if (collected.length >= result.total || result.items.length === 0) break;
    page += 1;
  }
  return collected;
}

export async function selectCampaignRecipients(
  db: OutreachDb,
  campaignId: string,
  input: { contactIds?: string[]; filter?: { status?: ContactStatus } },
  allowRepeatContact: boolean,
): Promise<RecipientSelectionResult> {
  const campaign = await db.campaigns.find(campaignId);
  if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
  if (campaign.status === 'CANCELLED' || campaign.status === 'COMPLETED') {
    throw new AppError(409, 'CAMPAIGN_NOT_EDITABLE', 'Recipients can only be added to an open campaign');
  }

  const contacts = await loadSelection(db, input);
  const counts = {
    selected: contacts.length,
    eligible: 0,
    alreadyContacted: 0,
    suppressed: 0,
    invalid: 0,
    alreadyQueued: 0,
    readyToQueue: 0,
  };

  await db.transaction(async (tx) => {
    for (const contact of contacts) {
      const suppression = await tx.suppressions.findByEmail(contact.normalizedEmail);
      const existing = await tx.recipients.findByCampaignContact(campaignId, contact.id);
      const klass = classifyForQueue({
        contact,
        suppressionReason: suppression?.reason ?? null,
        existingOnCampaign: Boolean(existing),
        allowRepeatContact,
      });
      if (klass === 'eligible') counts.eligible += 1;
      if (klass === 'alreadyContacted') counts.alreadyContacted += 1;
      if (klass === 'suppressed') counts.suppressed += 1;
      if (klass === 'invalid') counts.invalid += 1;
      if (klass === 'alreadyQueued') counts.alreadyQueued += 1;
      if (klass !== 'eligible') {
        if (klass !== 'alreadyQueued') {
          await tx.audit.create({
            eventType: 'CONTACT_SKIPPED',
            entityType: 'contact',
            entityId: contact.id,
            metadata: { campaignId, reason: klass, normalizedEmail: contact.normalizedEmail },
          });
        }
        continue;
      }
      try {
        await tx.recipients.create({ campaignId, contactId: contact.id, status: 'PENDING' });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        counts.eligible -= 1;
        counts.alreadyQueued += 1;
      }
    }
  });

  const recipients = await db.recipients.listByCampaign(campaignId);
  counts.readyToQueue = recipients.filter((row) => row.status === 'PENDING' || row.status === 'QUEUED').length;
  return counts;
}

export async function queueCampaign(db: OutreachDb, campaignId: string, allowRepeatContact: boolean, enqueue: (recipientId: string) => Promise<void>) {
  const campaign = await db.campaigns.find(campaignId);
  if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
  if (campaign.status === 'CANCELLED' || campaign.status === 'COMPLETED') {
    throw new AppError(409, 'CAMPAIGN_CLOSED', 'This campaign can no longer be queued');
  }

  const account = await db.gmailAccounts.getActive();
  if (!account) throw new AppError(409, 'GMAIL_NOT_CONNECTED', 'Connect a Gmail account before queueing a campaign');

  const recipients = await db.recipients.listByCampaign(campaignId);
  const pending = recipients.filter((row) => row.status === 'PENDING');
  let queued = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const recipient of pending) {
      const contact = await tx.contacts.findById(recipient.contactId);
      if (!contact) {
        await tx.recipients.update(recipient.id, { status: 'SKIPPED', lastError: 'Contact missing' });
        skipped += 1;
        continue;
      }
      const suppression = await tx.suppressions.findByEmail(contact.normalizedEmail);
      const klass = classifyForQueue({
        contact,
        suppressionReason: suppression?.reason ?? null,
        existingOnCampaign: false,
        allowRepeatContact,
      });
      if (klass !== 'eligible') {
        await tx.recipients.update(recipient.id, { status: 'SKIPPED', lastError: klass });
        await tx.audit.create({
          eventType: 'EMAIL_SKIPPED',
          entityType: 'campaign_recipient',
          entityId: recipient.id,
          metadata: { campaignId, reason: klass, normalizedEmail: contact.normalizedEmail },
        });
        skipped += 1;
        continue;
      }
      await tx.recipients.update(recipient.id, { status: 'QUEUED', scheduledAt: new Date(), lastError: null });
      if (contact.status === 'NEW') await tx.contacts.update(contact.id, { status: 'QUEUED' });
      queued += 1;
    }
    const nextStatus = queued > 0 || recipients.some((row) => row.status === 'QUEUED' || row.status === 'PROCESSING')
      ? 'RUNNING'
      : campaign.status;
    await tx.campaigns.update(campaignId, {
      status: nextStatus,
      startedAt: campaign.startedAt ?? new Date(),
      pausedAt: null,
    });
    await tx.audit.create({
      eventType: 'CAMPAIGN_QUEUED',
      entityType: 'campaign',
      entityId: campaignId,
      metadata: { queued, skipped },
    });
  });

  const queuedRows = (await db.recipients.listByCampaign(campaignId)).filter((row) => row.status === 'QUEUED' || row.status === 'PROCESSING');
  for (const row of queuedRows) await enqueue(row.id);
  return { queued, skipped, status: queuedRows.length ? 'RUNNING' : campaign.status };
}

export async function setCampaignControl(
  db: OutreachDb,
  campaignId: string,
  action: 'start' | 'pause' | 'resume' | 'cancel',
  enqueue: (recipientId: string) => Promise<void>,
  allowRepeatContact = false,
) {
  const campaign = await db.campaigns.find(campaignId);
  if (!campaign) throw new AppError(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found');
  const now = new Date();

  if (action === 'pause') {
    if (campaign.status !== 'RUNNING' && campaign.status !== 'QUEUED') {
      throw new AppError(409, 'CAMPAIGN_NOT_RUNNING', 'Only a running campaign can be paused');
    }
    const updated = await db.campaigns.update(campaignId, { status: 'PAUSED', pausedAt: now });
    await db.audit.create({ eventType: 'CAMPAIGN_PAUSED', entityType: 'campaign', entityId: campaignId, metadata: {} });
    return updated;
  }

  if (action === 'cancel') {
    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED') {
      throw new AppError(409, 'CAMPAIGN_CLOSED', 'This campaign is already closed');
    }
    await db.transaction(async (tx) => {
      const recipients = await tx.recipients.listByCampaign(campaignId);
      for (const recipient of recipients) {
        if (recipient.status === 'PENDING' || recipient.status === 'QUEUED') {
          await tx.recipients.update(recipient.id, { status: 'CANCELLED', lastError: 'Campaign cancelled' });
          const contact = await tx.contacts.findById(recipient.contactId);
          if (contact && contact.status === 'QUEUED' && !contact.firstSentAt) {
            await tx.contacts.update(contact.id, { status: 'NEW' });
          }
        }
      }
      await tx.campaigns.update(campaignId, { status: 'CANCELLED', completedAt: now });
    });
    return db.campaigns.find(campaignId);
  }

  if (campaign.status === 'CANCELLED' || campaign.status === 'COMPLETED') {
    throw new AppError(409, 'CAMPAIGN_CLOSED', 'This campaign is closed');
  }
  await queueCampaign(db, campaignId, allowRepeatContact, enqueue);
  if (action === 'resume') {
    await db.audit.create({
      eventType: 'CAMPAIGN_RESUMED',
      entityType: 'campaign',
      entityId: campaignId,
      metadata: { action },
    });
  }
  return db.campaigns.find(campaignId);
}

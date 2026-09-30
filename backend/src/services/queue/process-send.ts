import { rateLimitDecision, renderTemplate, retryDelayMs } from '@npm-outreach/shared';
import { ContactRecord, OutreachDb, RecipientRecord } from '../../db/types.js';
import { errorMessage, isTransientError } from '../../utils/gmail.js';

const PAUSE_REQUEUE_MS = 30_000;
const IN_FLIGHT_MS = 120_000;

export interface GmailSender {
  send(input: {
    from: string;
    to: string;
    subject: string;
    text: string;
    html?: string | null;
    unsubscribeUrl?: string | null;
  }): Promise<{ id: string; threadId: string | null }>;
}

export interface ProcessDeps {
  db: OutreachDb;
  gmail: GmailSender;
  fromEmail: string | null;
  allowRepeatContact: boolean;
  sendIntervalMs: number;
  maxPerHour: number;
  maxPerDay: number;
  appBaseUrl: string;
  includeUnsubscribe: boolean;
  now?: () => Date;
}

export type ProcessResult =
  | { action: 'sent' }
  | { action: 'already_sent' }
  | { action: 'skipped'; reason: string }
  | { action: 'failed'; error: string }
  | { action: 'paused'; rescheduleMs: number }
  | { action: 'rate_limited'; rescheduleMs: number }
  | { action: 'retry'; rescheduleMs: number; attempt: number }
  | { action: 'cancelled' }
  | { action: 'missing' }
  | { action: 'in_flight'; rescheduleMs: number };

function clock(deps: ProcessDeps): Date {
  return deps.now ? deps.now() : new Date();
}

async function completeCampaignIfDone(db: OutreachDb, campaignId: string): Promise<void> {
  const counts = await db.recipients.countByCampaign(campaignId);
  const open = counts.PENDING + counts.QUEUED + counts.PROCESSING;
  if (open > 0) return;
  const closed = counts.SENT + counts.FAILED + counts.SKIPPED + counts.CANCELLED;
  if (closed === 0) return;
  const campaign = await db.campaigns.find(campaignId);
  if (campaign && (campaign.status === 'RUNNING' || campaign.status === 'QUEUED')) {
    await db.campaigns.update(campaignId, { status: 'COMPLETED', completedAt: new Date() });
  }
}

async function finalizeSent(
  deps: ProcessDeps,
  recipient: Pick<RecipientRecord, 'id' | 'campaignId' | 'contactId'>,
  gmailMessageId: string,
  gmailThreadId: string | null,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const current = await tx.recipients.lock(recipient.id);
    if (!current) return;
    if (current.status === 'SENT' && current.gmailMessageId) return;
    const contact = await tx.contacts.lock(current.contactId);
    if (!contact) return;
    const sentAt = clock(deps);
    await tx.recipients.update(current.id, {
      status: 'SENT',
      sentAt,
      gmailMessageId,
      gmailThreadId,
      lastError: null,
    });
    await tx.contacts.update(contact.id, {
      status: 'CONTACTED',
      firstSentAt: contact.firstSentAt ?? sentAt,
      lastSentAt: sentAt,
      sendCount: contact.sendCount + 1,
    });
    const existing = await tx.suppressions.findByEmail(contact.normalizedEmail);
    if (!existing) {
      await tx.suppressions.create({
        normalizedEmail: contact.normalizedEmail,
        reason: 'ALREADY_CONTACTED',
        notes: 'Recorded after a successful Gmail send',
      });
    }
    await tx.audit.create({
      eventType: 'EMAIL_SENT',
      entityType: 'campaign_recipient',
      entityId: current.id,
      metadata: {
        campaignId: current.campaignId,
        normalizedEmail: contact.normalizedEmail,
        gmailMessageId,
      },
    });
    await tx.reconciliations.markResolved(current.id);
  });
  await completeCampaignIfDone(deps.db, recipient.campaignId);
}

async function failRecipient(deps: ProcessDeps, recipientId: string, campaignId: string, attempts: number, error: string, normalizedEmail?: string) {
  await deps.db.recipients.update(recipientId, { status: 'FAILED', attempts, lastError: error });
  await deps.db.audit.create({
    eventType: 'EMAIL_FAILED',
    entityType: 'campaign_recipient',
    entityId: recipientId,
    metadata: { campaignId, error, normalizedEmail: normalizedEmail ?? null },
  });
  await completeCampaignIfDone(deps.db, campaignId);
}

export async function processSendJob(deps: ProcessDeps, campaignRecipientId: string): Promise<ProcessResult> {
  const now = clock(deps);
  const gate = await deps.db.transaction(async (tx) => {
    const recipient = await tx.recipients.lock(campaignRecipientId);
    if (!recipient) return { type: 'missing' as const };
    if (recipient.status === 'SENT' || recipient.gmailMessageId) return { type: 'already_sent' as const };

    const reconciliation = await tx.reconciliations.findByRecipient(campaignRecipientId);
    if (reconciliation?.gmailMessageId && !reconciliation.resolved) {
      return { type: 'reconcile' as const, gmailMessageId: reconciliation.gmailMessageId, gmailThreadId: reconciliation.gmailThreadId, recipient };
    }
    if (recipient.status === 'FAILED' || recipient.status === 'SKIPPED' || recipient.status === 'CANCELLED') {
      return { type: 'terminal' as const, status: recipient.status };
    }

    const campaign = await tx.campaigns.find(recipient.campaignId);
    if (!campaign) return { type: 'missing' as const };
    if (campaign.status === 'CANCELLED') {
      await tx.recipients.update(recipient.id, { status: 'CANCELLED', lastError: 'Campaign cancelled' });
      return { type: 'cancelled' as const };
    }
    if (campaign.status === 'COMPLETED') return { type: 'terminal' as const, status: 'CANCELLED' as const };
    if (campaign.status !== 'RUNNING') {
      if (recipient.status === 'PROCESSING') await tx.recipients.update(recipient.id, { status: 'QUEUED' });
      return { type: 'paused' as const };
    }
    if (recipient.status === 'PROCESSING' && now.getTime() - recipient.updatedAt.getTime() < IN_FLIGHT_MS) {
      return { type: 'in_flight' as const };
    }

    const contact = await tx.contacts.lock(recipient.contactId);
    if (!contact) {
      await tx.recipients.update(recipient.id, { status: 'SKIPPED', lastError: 'Contact missing' });
      return { type: 'skipped' as const, reason: 'missing_contact' };
    }
    const suppression = await tx.suppressions.findByEmail(contact.normalizedEmail);
    if (suppression || contact.status === 'UNSUBSCRIBED' || contact.status === 'BLOCKED') {
      await tx.recipients.update(recipient.id, {
        status: 'SKIPPED',
        lastError: suppression ? `Suppressed: ${suppression.reason}` : contact.status,
      });
      await tx.audit.create({
        eventType: 'EMAIL_SKIPPED',
        entityType: 'campaign_recipient',
        entityId: recipient.id,
        metadata: { normalizedEmail: contact.normalizedEmail, reason: suppression?.reason || contact.status },
      });
      return { type: 'skipped' as const, reason: 'suppressed' };
    }
    const previouslySent = Boolean(contact.firstSentAt) || contact.sendCount > 0 || contact.status === 'CONTACTED';
    if (previouslySent && !deps.allowRepeatContact) {
      await tx.recipients.update(recipient.id, { status: 'SKIPPED', lastError: 'Already contacted' });
      await tx.audit.create({
        eventType: 'EMAIL_SKIPPED',
        entityType: 'campaign_recipient',
        entityId: recipient.id,
        metadata: { normalizedEmail: contact.normalizedEmail, reason: 'already_contacted' },
      });
      return { type: 'skipped' as const, reason: 'already_contacted' };
    }

    const claimed = await tx.recipients.update(recipient.id, { status: 'PROCESSING', lastError: null });
    const source = await tx.sources.latestForContact(contact.id);
    return { type: 'send' as const, recipient: claimed, contact, campaign, source };
  });

  if (gate.type === 'missing') return { action: 'missing' };
  if (gate.type === 'already_sent') return { action: 'already_sent' };
  if (gate.type === 'terminal') return { action: 'failed', error: `Recipient is ${gate.status}` };
  if (gate.type === 'paused') return { action: 'paused', rescheduleMs: PAUSE_REQUEUE_MS };
  if (gate.type === 'cancelled') return { action: 'cancelled' };
  if (gate.type === 'in_flight') return { action: 'in_flight', rescheduleMs: 15_000 };
  if (gate.type === 'skipped') return { action: 'skipped', reason: gate.reason };
  if (gate.type === 'reconcile') {
    await finalizeSent(deps, gate.recipient, gate.gmailMessageId, gate.gmailThreadId);
    return { action: 'sent' };
  }

  const window = await deps.db.recipients.sendWindow(clock(deps));
  const limit = rateLimitDecision({
    sentLastHour: window.sentLastHour,
    sentLastDay: window.sentLastDay,
    lastSentAt: window.lastSentAt,
    oldestSentLastHour: window.oldestSentLastHour,
    now: clock(deps),
    maxPerHour: deps.maxPerHour,
    maxPerDay: deps.maxPerDay,
    intervalMs: deps.sendIntervalMs,
  });
  if (!limit.ok) {
    await deps.db.recipients.update(campaignRecipientId, { status: 'QUEUED' });
    return { action: 'rate_limited', rescheduleMs: limit.waitMs };
  }
  if (!deps.fromEmail) {
    await deps.db.recipients.update(campaignRecipientId, { status: 'QUEUED', lastError: 'Gmail account is not connected' });
    return { action: 'rate_limited', rescheduleMs: 60_000 };
  }

  const freshCampaign = await deps.db.campaigns.find(gate.campaign.id);
  if (!freshCampaign || freshCampaign.status === 'PAUSED' || freshCampaign.status !== 'RUNNING') {
    if (freshCampaign?.status === 'CANCELLED') {
      await deps.db.recipients.update(campaignRecipientId, { status: 'CANCELLED', lastError: 'Campaign cancelled' });
      return { action: 'cancelled' };
    }
    await deps.db.recipients.update(campaignRecipientId, { status: 'QUEUED' });
    return { action: 'paused', rescheduleMs: PAUSE_REQUEUE_MS };
  }

  const freshContact = await deps.db.contacts.findById(gate.contact.id);
  const suppressionNow = freshContact ? await deps.db.suppressions.findByEmail(freshContact.normalizedEmail) : null;
  if (!freshContact || suppressionNow || freshContact.status === 'UNSUBSCRIBED' || freshContact.status === 'BLOCKED') {
    await deps.db.recipients.update(campaignRecipientId, { status: 'SKIPPED', lastError: 'Suppressed before send' });
    await deps.db.audit.create({
      eventType: 'EMAIL_SKIPPED',
      entityType: 'campaign_recipient',
      entityId: campaignRecipientId,
      metadata: { reason: suppressionNow?.reason || 'suppressed', normalizedEmail: freshContact?.normalizedEmail },
    });
    return { action: 'skipped', reason: 'suppressed' };
  }

  const vars = {
    name: freshContact.name || '',
    firstName: freshContact.firstName || '',
    email: freshContact.email,
    package: gate.source?.packageName || '',
    packageUrl: gate.source?.packageUrl || '',
  };
  const subject = renderTemplate(freshCampaign.subject, vars);
  const body = renderTemplate(freshCampaign.bodyText, vars);
  const html = freshCampaign.bodyHtml ? renderTemplate(freshCampaign.bodyHtml, vars) : null;
  const unresolved = [...new Set([...subject.unresolved, ...body.unresolved, ...(html?.unresolved ?? [])])];
  if (unresolved.length) {
    await failRecipient(deps, campaignRecipientId, freshCampaign.id, gate.recipient.attempts + 1, `Unresolved template variables: ${unresolved.join(', ')}`, freshContact.normalizedEmail);
    return { action: 'failed', error: `Unresolved template variables: ${unresolved.join(', ')}` };
  }

  const unsubscribeUrl = deps.includeUnsubscribe && deps.appBaseUrl
    ? `${deps.appBaseUrl.replace(/\/$/, '')}/unsubscribe/${freshContact.unsubscribeToken}`
    : null;
  let text = body.text;
  if (unsubscribeUrl && !text.includes(unsubscribeUrl)) {
    text = `${text.trimEnd()}\n\nUnsubscribe: ${unsubscribeUrl}\n`;
  }

  let sent: { id: string; threadId: string | null };
  try {
    sent = await deps.gmail.send({
      from: deps.fromEmail,
      to: freshContact.email,
      subject: subject.text,
      text,
      html: html?.text ?? null,
      unsubscribeUrl,
    });
  } catch (error) {
    const attempts = gate.recipient.attempts + 1;
    const message = errorMessage(error);
    if (!isTransientError(error) || attempts >= 3) {
      await failRecipient(deps, campaignRecipientId, freshCampaign.id, attempts, message, freshContact.normalizedEmail);
      return { action: 'failed', error: message };
    }
    const delay = retryDelayMs(attempts) ?? 30_000;
    await deps.db.recipients.update(campaignRecipientId, { status: 'QUEUED', attempts, lastError: message });
    return { action: 'retry', rescheduleMs: delay, attempt: attempts };
  }

  try {
    await finalizeSent(deps, gate.recipient, sent.id, sent.threadId);
  } catch (error) {
    try {
      await deps.db.reconciliations.create({
        campaignRecipientId,
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
        normalizedEmail: freshContact.normalizedEmail,
        error: errorMessage(error),
      });
    } catch (reconcileError) {
      console.error('Failed to record send reconciliation', errorMessage(reconcileError), sent.id);
    }
    return { action: 'retry', rescheduleMs: 15_000, attempt: gate.recipient.attempts };
  }
  return { action: 'sent' };
}

export function templatePreview(subject: string, bodyText: string, sample?: Partial<ContactRecord> & { packageName?: string; packageUrl?: string }) {
  const vars = {
    name: sample?.name || 'Ada Lovelace',
    firstName: sample?.firstName || 'Ada',
    email: sample?.email || 'ada@example.com',
    package: sample?.packageName || 'example-package',
    packageUrl: sample?.packageUrl || 'https://www.npmjs.com/package/example-package',
  };
  return {
    subject: renderTemplate(subject, vars).text,
    bodyText: renderTemplate(bodyText, vars).text,
  };
}

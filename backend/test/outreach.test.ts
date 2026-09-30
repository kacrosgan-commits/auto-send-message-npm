import { describe, expect, it } from 'vitest';
import { isNoreplyAddress, normalizeEmail, renderTemplate, retryDelayMs } from '@npm-outreach/shared';
import { createMemoryDb } from '../src/db/memory.js';
import { selectCampaignRecipients, queueCampaign, setCampaignControl } from '../src/services/campaigns/campaign-service.js';
import { ingestContacts } from '../src/services/contacts/contact-service.js';
import { GmailSender, processSendJob } from '../src/services/queue/process-send.js';
import { OutreachDb } from '../src/db/types.js';

async function ingestOne(db: OutreachDb, email: string, packageName: string, role = 'maintainer', name = 'John Smith') {
  return ingestContacts(db, [{ email, name, packageName, packageUrl: `https://www.npmjs.com/package/${packageName}`, keyword: 'react', role }]);
}

function trackSender(impl: (call: number) => ReturnType<GmailSender['send']> | Promise<ReturnType<GmailSender['send']>>) {
  let calls = 0;
  const gmail: GmailSender = {
    async send(_input) {
      calls += 1;
      return impl(calls);
    },
  };
  return { gmail, get calls() { return calls; } };
}

async function runningRecipient(db: OutreachDb, email = 'john@example.com') {
  await ingestOne(db, email, 'example-package');
  const contact = await db.contacts.findByNormalized(normalizeEmail(email));
  if (!contact) throw new Error('missing contact');
  const campaign = await db.campaigns.create({
    name: 'Outreach',
    subject: 'Question about {{package}}',
    bodyText: 'Hi {{firstName}},\n\nI came across {{package}}.',
    bodyHtml: null,
  });
  await db.campaigns.update(campaign.id, { status: 'RUNNING', startedAt: new Date() });
  const recipient = await db.recipients.create({ campaignId: campaign.id, contactId: contact.id, status: 'QUEUED' });
  return { contact, campaign, recipient };
}

function sendDeps(db: OutreachDb, gmail: GmailSender) {
  return {
    db,
    gmail,
    fromEmail: 'sender@gmail.com',
    allowRepeatContact: false,
    sendIntervalMs: 0,
    maxPerHour: 1000,
    maxPerDay: 1000,
    appBaseUrl: 'http://localhost:3000',
    includeUnsubscribe: true,
  };
}

describe('email rules', () => {
  it('normalizes email addresses', () => {
    expect(normalizeEmail('  John.Doe@Example.COM ')).toBe('john.doe@example.com');
  });

  it('rejects noreply addresses', () => {
    expect(isNoreplyAddress('noreply@example.com')).toBe(true);
    expect(isNoreplyAddress('bot@users.noreply.github.com')).toBe(true);
    expect(isNoreplyAddress('ada@example.com')).toBe(false);
  });

  it('falls back when firstName is empty and blocks unknown variables', () => {
    expect(renderTemplate('Hi {{firstName}},', { firstName: '' }).text).toBe('Hi,');
    expect(renderTemplate('Hi {{first name}},', { firstName: 'Ada' }).text).toBe('Hi Ada,');
    expect(renderTemplate('Hi {{nickname}},', {}).unresolved).toEqual(['nickname']);
  });

  it('uses bounded retry delays', () => {
    expect(retryDelayMs(1)).toBe(30_000);
    expect(retryDelayMs(2)).toBe(120_000);
    expect(retryDelayMs(3)).toBeNull();
  });
});

describe('contact ingestion', () => {
  it('stores one contact when the same email is discovered twice', async () => {
    const db = createMemoryDb();
    await ingestOne(db, 'John.Doe@Example.COM', 'left-pad');
    await ingestOne(db, 'john.doe@example.com', 'left-pad');
    const rows = await db.contacts.search({ page: 1, limit: 20 });
    expect(rows.total).toBe(1);
    expect(rows.items[0].normalizedEmail).toBe('john.doe@example.com');
  });

  it('stores one contact and two sources for two packages', async () => {
    const db = createMemoryDb();
    await ingestOne(db, 'ada@example.com', 'alpha', 'maintainer');
    await ingestOne(db, 'Ada@Example.com', 'beta', 'author', 'Ada Lovelace');
    const contact = await db.contacts.findByNormalized('ada@example.com');
    expect(contact).toBeTruthy();
    const sources = await db.sources.listForContact(contact!.id);
    expect(sources).toHaveLength(2);
    expect(sources.map((source) => source.packageName).sort()).toEqual(['alpha', 'beta']);
  });

  it('rejects noreply addresses without creating a contact', async () => {
    const db = createMemoryDb();
    const result = await ingestContacts(db, [{ email: 'no-reply@example.com', packageName: 'pkg', role: 'publisher' }]);
    expect(result.summary.invalid).toBe(1);
    expect(result.contacts[0].eligibility).toBe('INVALID');
    expect((await db.contacts.search({ page: 1, limit: 10 })).total).toBe(0);
  });
});

describe('campaign duplicate prevention', () => {
  it('does not queue a previously sent contact', async () => {
    const db = createMemoryDb();
    await ingestOne(db, 'sent@example.com', 'pkg');
    const contact = await db.contacts.findByNormalized('sent@example.com');
    await db.contacts.update(contact!.id, { status: 'CONTACTED', firstSentAt: new Date(), sendCount: 1 });
    const campaign = await db.campaigns.create({ name: 'Next', subject: 'Hi', bodyText: 'Hello', bodyHtml: null });
    const selection = await selectCampaignRecipients(db, campaign.id, { contactIds: [contact!.id] }, false);
    expect(selection.alreadyContacted).toBe(1);
    expect(selection.eligible).toBe(0);
    expect(await db.recipients.listByCampaign(campaign.id)).toHaveLength(0);
  });

  it('does not queue a suppressed contact', async () => {
    const db = createMemoryDb();
    await db.suppressions.create({ normalizedEmail: 'blocked@example.com', reason: 'MANUAL_BLOCK', notes: null });
    await ingestOne(db, 'blocked@example.com', 'pkg');
    const contact = await db.contacts.findByNormalized('blocked@example.com');
    const campaign = await db.campaigns.create({ name: 'Next', subject: 'Hi', bodyText: 'Hello', bodyHtml: null });
    const selection = await selectCampaignRecipients(db, campaign.id, { contactIds: [contact!.id] }, false);
    expect(selection.suppressed).toBe(1);
    expect(selection.eligible).toBe(0);
    expect(await db.recipients.listByCampaign(campaign.id)).toHaveLength(0);
  });

  it('does not duplicate recipients when queue is requested twice', async () => {
    const db = createMemoryDb();
    await db.gmailAccounts.upsert({
      email: 'me@gmail.com',
      googleAccountId: 'g-1',
      encryptedRefreshToken: 'encrypted',
      scopes: 'https://www.googleapis.com/auth/gmail.send',
    });
    await ingestOne(db, 'new@example.com', 'pkg');
    const contact = await db.contacts.findByNormalized('new@example.com');
    const campaign = await db.campaigns.create({ name: 'Draft', subject: 'Hi', bodyText: 'Hello', bodyHtml: null });
    await selectCampaignRecipients(db, campaign.id, { contactIds: [contact!.id] }, false);
    const jobs: string[] = [];
    await queueCampaign(db, campaign.id, false, async (id) => { jobs.push(id); });
    await queueCampaign(db, campaign.id, false, async (id) => { jobs.push(id); });
    const recipients = await db.recipients.listByCampaign(campaign.id);
    expect(recipients).toHaveLength(1);
    expect(new Set(jobs).size).toBe(jobs.length === 0 ? 0 : 1);
  });

  it('start sends jobs for pending recipients on a running campaign', async () => {
    const db = createMemoryDb();
    await db.gmailAccounts.upsert({
      email: 'me@gmail.com',
      googleAccountId: 'g-1',
      encryptedRefreshToken: 'encrypted',
      scopes: 'https://www.googleapis.com/auth/gmail.send',
    });
    await ingestOne(db, 'pending@example.com', 'pkg');
    const contact = await db.contacts.findByNormalized('pending@example.com');
    const campaign = await db.campaigns.create({ name: 'Live', subject: 'Hi', bodyText: 'Hello', bodyHtml: null });
    await selectCampaignRecipients(db, campaign.id, { contactIds: [contact!.id] }, false);
    await db.campaigns.update(campaign.id, { status: 'RUNNING', startedAt: new Date() });
    const jobs: string[] = [];
    const updated = await setCampaignControl(db, campaign.id, 'start', async (id) => { jobs.push(id); }, false);
    const recipients = await db.recipients.listByCampaign(campaign.id);
    expect(updated?.status).toBe('RUNNING');
    expect(recipients).toHaveLength(1);
    expect(recipients[0].status).toBe('QUEUED');
    expect(jobs).toEqual([recipients[0].id]);
  });

  it('adds selected contacts to a campaign that is already running', async () => {
    const db = createMemoryDb();
    await ingestOne(db, 'live@example.com', 'pkg');
    const contact = await db.contacts.findByNormalized('live@example.com');
    const campaign = await db.campaigns.create({ name: 'Live', subject: 'Hi', bodyText: 'Hello', bodyHtml: null });
    await db.campaigns.update(campaign.id, { status: 'RUNNING', startedAt: new Date() });
    const selection = await selectCampaignRecipients(db, campaign.id, { contactIds: [contact!.id] }, false);
    expect(selection.eligible).toBe(1);
    expect((await db.recipients.listByCampaign(campaign.id))[0].status).toBe('PENDING');
  });
});

describe('send worker', () => {
  it('sends at most once when the same job is processed twice', async () => {
    const db = createMemoryDb();
    const { recipient } = await runningRecipient(db);
    const tracked = trackSender(async () => ({ id: 'msg-1', threadId: 'thread-1' }));
    const deps = sendDeps(db, tracked.gmail);
    const first = await processSendJob(deps, recipient.id);
    const second = await processSendJob(deps, recipient.id);
    expect(first.action).toBe('sent');
    expect(second.action).toBe('already_sent');
    expect(tracked.calls).toBe(1);
  });

  it('does not start a send while the campaign is paused', async () => {
    const db = createMemoryDb();
    const { campaign, recipient } = await runningRecipient(db);
    await db.campaigns.update(campaign.id, { status: 'PAUSED', pausedAt: new Date() });
    const tracked = trackSender(async () => ({ id: 'msg', threadId: null }));
    const result = await processSendJob(sendDeps(db, tracked.gmail), recipient.id);
    expect(result.action).toBe('paused');
    expect(tracked.calls).toBe(0);
    expect((await db.recipients.find(recipient.id))?.status).not.toBe('SENT');
  });

  it('retries a transient Gmail failure and stops after a permanent failure', async () => {
    const db = createMemoryDb();
    const { recipient } = await runningRecipient(db, 'retry@example.com');
    const transient = trackSender(async () => {
      const error = new Error('rate limit');
      (error as { status?: number }).status = 429;
      throw error;
    });
    const retry = await processSendJob(sendDeps(db, transient.gmail), recipient.id);
    expect(retry.action).toBe('retry');
    if (retry.action === 'retry') expect(retry.rescheduleMs).toBe(30_000);
    expect((await db.recipients.find(recipient.id))?.status).toBe('QUEUED');
    expect((await db.recipients.find(recipient.id))?.attempts).toBe(1);

    const permanentDb = createMemoryDb();
    const seeded = await runningRecipient(permanentDb, 'bad@example.com');
    const permanent = trackSender(async () => {
      const error = new Error('invalid recipient');
      (error as { status?: number }).status = 400;
      throw error;
    });
    const failed = await processSendJob(sendDeps(permanentDb, permanent.gmail), seeded.recipient.id);
    const again = await processSendJob(sendDeps(permanentDb, permanent.gmail), seeded.recipient.id);
    expect(failed.action).toBe('failed');
    expect(again.action).toBe('failed');
    expect(permanent.calls).toBe(1);
    expect((await permanentDb.recipients.find(seeded.recipient.id))?.status).toBe('FAILED');
  });

  it('does not retry forever after three transient failures', async () => {
    const db = createMemoryDb();
    const { recipient } = await runningRecipient(db, 'flake@example.com');
    const tracked = trackSender(async () => {
      const error = new Error('unavailable');
      (error as { status?: number }).status = 503;
      throw error;
    });
    const deps = sendDeps(db, tracked.gmail);
    const first = await processSendJob(deps, recipient.id);
    const second = await processSendJob(deps, recipient.id);
    const third = await processSendJob(deps, recipient.id);
    expect(first.action).toBe('retry');
    expect(second.action).toBe('retry');
    if (second.action === 'retry') expect(second.rescheduleMs).toBe(120_000);
    expect(third.action).toBe('failed');
    expect(tracked.calls).toBe(3);
    expect((await db.recipients.find(recipient.id))?.status).toBe('FAILED');
  });

  it('updates the recipient, contact, and audit log after a successful send', async () => {
    const db = createMemoryDb();
    const { recipient, contact } = await runningRecipient(db, 'done@example.com');
    const tracked = trackSender(async () => ({ id: 'gmail-123', threadId: 'thread-9' }));
    const result = await processSendJob(sendDeps(db, tracked.gmail), recipient.id);
    expect(result.action).toBe('sent');
    const saved = await db.recipients.find(recipient.id);
    const updated = await db.contacts.findById(contact.id);
    const audits = await db.audit.list();
    expect(saved?.status).toBe('SENT');
    expect(saved?.gmailMessageId).toBe('gmail-123');
    expect(saved?.sentAt).toBeTruthy();
    expect(updated?.status).toBe('CONTACTED');
    expect(updated?.sendCount).toBe(1);
    expect(updated?.firstSentAt).toBeTruthy();
    expect(audits.some((event) => event.eventType === 'EMAIL_SENT')).toBe(true);
    const suppression = await db.suppressions.findByEmail('done@example.com');
    expect(suppression?.reason).toBe('ALREADY_CONTACTED');
  });
});

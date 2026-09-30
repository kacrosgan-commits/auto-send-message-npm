import { PrismaClient } from '@prisma/client';
import { AppConfig } from '../../config/env.js';
import { OutreachDb } from '../../db/types.js';
import { queueCampaign } from '../campaigns/campaign-service.js';
import { createGmailSender } from '../gmail/gmail-service.js';
import { processSendJob } from './process-send.js';

export const GMAIL_SEND_QUEUE = 'gmail-send';

export interface SendQueue {
  enqueue(campaignRecipientId: string, startAfterMs?: number): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSendQueue(config: AppConfig, db: OutreachDb, prisma: PrismaClient): SendQueue {
  let timer: NodeJS.Timeout | null = null;
  let ticking = false;
  let stopped = true;

  async function enqueue(campaignRecipientId: string, startAfterMs?: number) {
    const runAt = new Date(Date.now() + (startAfterMs && startAfterMs > 0 ? startAfterMs : 0));
    const singletonKey = startAfterMs && startAfterMs > 0
      ? `${campaignRecipientId}:followup`
      : campaignRecipientId;
    const existing = await prisma.sendJob.findUnique({ where: { singletonKey } });
    if (existing) {
      if (existing.status === 'PENDING' && existing.runAt.getTime() <= runAt.getTime()) return;
      await prisma.sendJob.update({
        where: { id: existing.id },
        data: { campaignRecipientId, runAt, status: 'PENDING' },
      });
      return;
    }
    await prisma.sendJob.create({
      data: { campaignRecipientId, singletonKey, runAt, status: 'PENDING' },
    });
  }

  async function resumeRunningCampaigns() {
    const campaigns = await db.campaigns.list();
    for (const campaign of campaigns) {
      if (campaign.status !== 'RUNNING' && campaign.status !== 'QUEUED') continue;
      try {
        await queueCampaign(db, campaign.id, config.allowRepeatContact, enqueue);
      } catch (error) {
        console.error('failed to resume campaign', campaign.id, error instanceof Error ? error.message : error);
      }
    }
  }

  async function tick() {
    if (stopped || ticking) return;
    ticking = true;
    try {
      const now = new Date();
      const staleBefore = new Date(now.getTime() - 2 * 60 * 1000);
      const job = await prisma.sendJob.findFirst({
        where: {
          OR: [
            { status: 'PENDING', runAt: { lte: now } },
            { status: 'ACTIVE', updatedAt: { lte: staleBefore } },
          ],
        },
        orderBy: { runAt: 'asc' },
      });
      if (!job) return;
      const claimed = await prisma.sendJob.updateMany({
        where: { id: job.id, status: job.status },
        data: { status: 'ACTIVE' },
      });
      if (claimed.count !== 1) return;
      let rescheduleMs = 0;
      let failed = false;
      try {
        const account = await db.gmailAccounts.getActive();
        const result = await processSendJob({
          db,
          gmail: createGmailSender(db, config),
          fromEmail: account?.email ?? null,
          allowRepeatContact: config.allowRepeatContact,
          sendIntervalMs: config.emailSendIntervalMs,
          maxPerHour: config.maxEmailsPerHour,
          maxPerDay: config.maxEmailsPerDay,
          appBaseUrl: config.appBaseUrl,
          includeUnsubscribe: config.includeUnsubscribeLink,
        }, job.campaignRecipientId);
        if ('rescheduleMs' in result && result.rescheduleMs > 0) rescheduleMs = result.rescheduleMs;
      } catch (error) {
        failed = true;
        rescheduleMs = 15_000;
        console.error('gmail-send job error', error instanceof Error ? error.message : error);
      }
      if (failed) {
        await prisma.sendJob.update({
          where: { id: job.id },
          data: { status: 'PENDING', runAt: new Date(Date.now() + rescheduleMs) },
        });
        return;
      }
      await prisma.sendJob.update({ where: { id: job.id }, data: { status: 'DONE' } });
      if (rescheduleMs > 0) await enqueue(job.campaignRecipientId, rescheduleMs);
    } finally {
      ticking = false;
    }
  }

  return {
    enqueue,
    async start() {
      stopped = false;
      if (!timer) timer = setInterval(() => { void tick(); }, 1000);
      await resumeRunningCampaigns();
      await tick();
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

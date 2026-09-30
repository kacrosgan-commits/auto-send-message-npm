import PgBoss from 'pg-boss';
import { AppConfig } from '../../config/env';
import { OutreachDb } from '../../db/types';
import { createGmailSender } from '../gmail/gmail-service';
import { processSendJob } from './process-send';

export const GMAIL_SEND_QUEUE = 'gmail-send';

export interface SendQueue {
  enqueue(campaignRecipientId: string, startAfterMs?: number): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createPgBossQueue(config: AppConfig, db: OutreachDb): SendQueue {
  const boss = new PgBoss({
    connectionString: config.databaseUrl,
    noSupervisor: false,
  });
  let started = false;

  return {
    async enqueue(campaignRecipientId, startAfterMs) {
      if (!started) {
        await boss.start();
        started = true;
      }
      const options: { singletonKey: string; startAfter?: Date } = { singletonKey: campaignRecipientId };
      if (startAfterMs && startAfterMs > 0) options.startAfter = new Date(Date.now() + startAfterMs);
      await boss.send(GMAIL_SEND_QUEUE, { campaignRecipientId }, options);
    },
    async start() {
      if (!started) {
        await boss.start();
        started = true;
      }
      await boss.work(GMAIL_SEND_QUEUE, { teamSize: 1, teamConcurrency: 1 }, async (job) => {
        const data = job.data as { campaignRecipientId?: string };
        if (!data?.campaignRecipientId) return;
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
          }, data.campaignRecipientId);
          if ('rescheduleMs' in result && result.rescheduleMs > 0) {
            await boss.send(GMAIL_SEND_QUEUE, { campaignRecipientId: data.campaignRecipientId }, {
              singletonKey: `${data.campaignRecipientId}:followup`,
              startAfter: new Date(Date.now() + result.rescheduleMs),
            });
          }
        } catch (error) {
          console.error('gmail-send job error', error instanceof Error ? error.message : error);
        }
      });
    },
    async stop() {
      if (started) await boss.stop();
      started = false;
    },
  };
}

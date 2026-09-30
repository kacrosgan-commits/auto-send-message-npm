import {
  CampaignStatus,
  ContactStatus,
  RecipientStatus,
  SuppressionReason,
} from '@npm-outreach/shared';

export interface ContactRecord {
  id: string;
  email: string;
  normalizedEmail: string;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  status: ContactStatus;
  firstDiscoveredAt: Date;
  lastDiscoveredAt: Date;
  firstSentAt: Date | null;
  lastSentAt: Date | null;
  sendCount: number;
  unsubscribeToken: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactSourceRecord {
  id: string;
  contactId: string;
  sourceType: string;
  packageName: string;
  packageUrl: string | null;
  npmKeyword: string | null;
  sourceRole: string;
  discoveredAt: Date;
}

export interface CampaignRecord {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  status: CampaignStatus;
  createdAt: Date;
  startedAt: Date | null;
  pausedAt: Date | null;
  completedAt: Date | null;
}

export interface RecipientRecord {
  id: string;
  campaignId: string;
  contactId: string;
  status: RecipientStatus;
  scheduledAt: Date | null;
  sentAt: Date | null;
  attempts: number;
  gmailMessageId: string | null;
  gmailThreadId: string | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SuppressionRecord {
  id: string;
  normalizedEmail: string;
  reason: SuppressionReason;
  notes: string | null;
  createdAt: Date;
}

export interface GmailAccountRecord {
  id: string;
  email: string;
  googleAccountId: string;
  encryptedRefreshToken: string;
  scopes: string;
  connectedAt: Date;
  updatedAt: Date;
  isActive: boolean;
}

export interface AuditRecord {
  id: string;
  eventType: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface ReconciliationRecord {
  id: string;
  campaignRecipientId: string;
  gmailMessageId: string;
  gmailThreadId: string | null;
  normalizedEmail: string;
  error: string;
  resolved: boolean;
  createdAt: Date;
}

export interface ContactSearchParams {
  status?: ContactStatus;
  search?: string;
  page: number;
  limit: number;
  contacted?: boolean;
  suppressed?: boolean;
  suppressedEmails?: Set<string>;
}

export interface HistoryRow {
  recipientId: string;
  email: string;
  name: string | null;
  campaignId: string;
  campaignName: string;
  packageName: string | null;
  sentAt: Date | null;
  gmailMessageId: string | null;
  status: RecipientStatus;
  lastError: string | null;
}

export interface SendWindowStats {
  sentLastHour: number;
  sentLastDay: number;
  lastSentAt: Date | null;
  oldestSentLastHour: Date | null;
}

export interface OutreachDb {
  transaction<T>(fn: (tx: OutreachDb) => Promise<T>): Promise<T>;
  contacts: {
    findByNormalized(email: string): Promise<ContactRecord | null>;
    findById(id: string): Promise<ContactRecord | null>;
    findByIds(ids: string[]): Promise<ContactRecord[]>;
    findByUnsubscribeToken(token: string): Promise<ContactRecord | null>;
    search(params: ContactSearchParams): Promise<{ items: ContactRecord[]; total: number }>;
    create(data: Omit<ContactRecord, 'createdAt' | 'updatedAt'> & { createdAt?: Date; updatedAt?: Date }): Promise<ContactRecord>;
    update(id: string, data: Partial<ContactRecord>): Promise<ContactRecord>;
    lock(id: string): Promise<ContactRecord | null>;
    countByStatus(): Promise<Record<ContactStatus, number>>;
  };
  sources: {
    findMatch(contactId: string, packageName: string, sourceRole: string, sourceType: string): Promise<ContactSourceRecord | null>;
    create(data: Omit<ContactSourceRecord, 'id' | 'discoveredAt'> & { id?: string; discoveredAt?: Date }): Promise<ContactSourceRecord>;
    listForContact(contactId: string): Promise<ContactSourceRecord[]>;
    latestForContact(contactId: string): Promise<ContactSourceRecord | null>;
    latestForContacts(contactIds: string[]): Promise<Map<string, ContactSourceRecord>>;
  };
  suppressions: {
    findByEmail(email: string): Promise<SuppressionRecord | null>;
    findById(id: string): Promise<SuppressionRecord | null>;
    list(): Promise<SuppressionRecord[]>;
    create(data: Omit<SuppressionRecord, 'id' | 'createdAt'> & { id?: string; createdAt?: Date }): Promise<SuppressionRecord>;
    delete(id: string): Promise<void>;
    emails(): Promise<Set<string>>;
    count(): Promise<number>;
  };
  campaigns: {
    create(data: Omit<CampaignRecord, 'id' | 'createdAt' | 'startedAt' | 'pausedAt' | 'completedAt' | 'status'> & { id?: string; status?: CampaignStatus }): Promise<CampaignRecord>;
    list(): Promise<CampaignRecord[]>;
    find(id: string): Promise<CampaignRecord | null>;
    update(id: string, data: Partial<CampaignRecord>): Promise<CampaignRecord>;
    delete(id: string): Promise<void>;
  };
  recipients: {
    find(id: string): Promise<RecipientRecord | null>;
    lock(id: string): Promise<RecipientRecord | null>;
    findByCampaignContact(campaignId: string, contactId: string): Promise<RecipientRecord | null>;
    listByCampaign(campaignId: string): Promise<RecipientRecord[]>;
    create(data: { campaignId: string; contactId: string; status?: RecipientStatus; scheduledAt?: Date | null }): Promise<RecipientRecord>;
    update(id: string, data: Partial<RecipientRecord>): Promise<RecipientRecord>;
    countByCampaign(campaignId: string): Promise<Record<RecipientStatus, number>>;
    sendWindow(now: Date): Promise<SendWindowStats>;
    history(params: { search?: string; page: number; limit: number }): Promise<{ items: HistoryRow[]; total: number }>;
    listCampaignPage(campaignId: string, page: number, limit: number): Promise<{ items: Array<RecipientRecord & { email: string; name: string | null; packageName: string | null }>; total: number }>;
  };
  audit: {
    create(event: { eventType: string; entityType: string; entityId?: string | null; metadata?: Record<string, unknown> }): Promise<AuditRecord>;
    list(): Promise<AuditRecord[]>;
  };
  gmailAccounts: {
    getActive(): Promise<GmailAccountRecord | null>;
    upsert(data: { email: string; googleAccountId: string; encryptedRefreshToken: string; scopes: string }): Promise<GmailAccountRecord>;
    deactivate(): Promise<void>;
  };
  oauthStates: {
    create(state: string, expiresAt: Date): Promise<void>;
    consume(state: string, now: Date): Promise<boolean>;
  };
  reconciliations: {
    create(data: Omit<ReconciliationRecord, 'id' | 'createdAt' | 'resolved'> & { resolved?: boolean }): Promise<ReconciliationRecord>;
    findByRecipient(campaignRecipientId: string): Promise<ReconciliationRecord | null>;
    markResolved(campaignRecipientId: string): Promise<void>;
  };
}

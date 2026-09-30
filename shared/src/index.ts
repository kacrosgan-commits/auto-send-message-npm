export const CONTACT_STATUSES = [
  'NEW',
  'QUEUED',
  'CONTACTED',
  'BOUNCED',
  'INVALID',
  'UNSUBSCRIBED',
  'BLOCKED',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const CAMPAIGN_STATUSES = [
  'DRAFT',
  'QUEUED',
  'RUNNING',
  'PAUSED',
  'COMPLETED',
  'CANCELLED',
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

export const RECIPIENT_STATUSES = [
  'PENDING',
  'QUEUED',
  'PROCESSING',
  'SENT',
  'FAILED',
  'SKIPPED',
  'CANCELLED',
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const SUPPRESSION_REASONS = [
  'ALREADY_CONTACTED',
  'UNSUBSCRIBED',
  'HARD_BOUNCE',
  'COMPLAINT',
  'INVALID',
  'MANUAL_BLOCK',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const SOURCE_ROLES = ['maintainer', 'author', 'contributor', 'publisher'] as const;
export type SourceRole = (typeof SOURCE_ROLES)[number];

export const TEMPLATE_VARIABLES = ['name', 'firstName', 'email', 'package', 'packageUrl'] as const;
export type TemplateVariable = (typeof TEMPLATE_VARIABLES)[number];

export type Eligibility = 'NEW' | 'ALREADY_CONTACTED' | 'SUPPRESSED' | 'INVALID';

export interface IngestContactInput {
  email: string;
  name?: string | null;
  packageName?: string | null;
  packageUrl?: string | null;
  keyword?: string | null;
  role?: string | null;
}

export interface IngestContactResult {
  email: string;
  normalizedEmail: string;
  eligibility: Eligibility;
  contactId?: string;
  status?: ContactStatus;
  reason?: string;
  name?: string | null;
  packageName?: string | null;
  role?: string | null;
}

export interface IngestSummary {
  received: number;
  new: number;
  alreadyContacted: number;
  suppressed: number;
  invalid: number;
}

export interface IngestResponse {
  summary: IngestSummary;
  contacts: IngestContactResult[];
}

export interface RecipientSelectionResult {
  selected: number;
  eligible: number;
  alreadyContacted: number;
  suppressed: number;
  invalid: number;
  alreadyQueued: number;
  readyToQueue: number;
}

export function normalizeEmail(email: string): string {
  return String(email ?? '').trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  const value = normalizeEmail(email);
  if (!value || value.length > 320) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(value);
}

/** Same no-reply / bot detection the npm collector already uses, plus a few obvious aliases. */
export function isNoreplyAddress(email: string): boolean {
  const s = normalizeEmail(email);
  return /(^|[._+-])(no-?reply|donot-?reply|do-?not-?reply)([._+@-]|$)/i.test(s) ||
    /users\.noreply\.github\.com$/i.test(s) ||
    /(^|[._+-])bot([._+@-]|$)/i.test(s) ||
    /(^|[._+-])(notifications?|mailer-daemon)([._+@-]|$)/i.test(s);
}

export function normalizeRole(role: string | null | undefined): SourceRole {
  const s = String(role || '').toLowerCase();
  if (s.includes('maintainer')) return 'maintainer';
  if (s.includes('contributor')) return 'contributor';
  if (s.includes('author')) return 'author';
  if (s.includes('publisher')) return 'publisher';
  return 'publisher';
}

export function splitName(name: string | null | undefined): { firstName: string | null; lastName: string | null } {
  const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return { firstName: null, lastName: null };
  const parts = trimmed.split(' ');
  return {
    firstName: parts[0] || null,
    lastName: parts.length > 1 ? parts.slice(1).join(' ') : null,
  };
}

const KNOWN_VARIABLES = new Set<string>(TEMPLATE_VARIABLES);

export interface RenderedTemplate {
  text: string;
  unresolved: string[];
}

export function renderTemplate(
  input: string,
  vars: Partial<Record<TemplateVariable, string | null | undefined>>,
): RenderedTemplate {
  const source = String(input ?? '');
  const unresolved = [...source.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)]
    .map((match) => match[1])
    .filter((name) => !KNOWN_VARIABLES.has(name));

  let text = source.replace(/\{\{\s*(name|firstName|email|package|packageUrl)\s*\}\}/g, (_full, key: TemplateVariable) => {
    const value = vars[key];
    if (value == null) return '';
    return String(value);
  });

  text = text.replace(/\bHi\s+,/g, 'Hi,');
  text = text.replace(/^Hi\s*$/gm, 'Hi,');
  text = text.replace(/\bHello\s+,/g, 'Hello,');
  text = text.replace(/^Hello\s*$/gm, 'Hello,');

  return { text, unresolved: [...new Set(unresolved)] };
}

export function retryDelayMs(failedAttempts: number): number | null {
  if (failedAttempts <= 0 || failedAttempts >= 3) return null;
  if (failedAttempts === 1) return 30_000;
  if (failedAttempts === 2) return 120_000;
  return null;
}

export function isTransientStatus(status: number | null | undefined): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export interface RateLimitInput {
  sentLastHour: number;
  sentLastDay: number;
  lastSentAt: Date | null;
  now: Date;
  maxPerHour: number;
  maxPerDay: number;
  intervalMs: number;
  oldestSentLastHour?: Date | null;
}

export type RateLimitDecision =
  | { ok: true }
  | { ok: false; waitMs: number; reason: 'hourly_cap' | 'daily_cap' | 'interval' };

export function rateLimitDecision(input: RateLimitInput): RateLimitDecision {
  const maxPerHour = Math.max(1, input.maxPerHour);
  const maxPerDay = Math.max(1, input.maxPerDay);
  const intervalMs = Math.max(0, input.intervalMs);

  if (input.sentLastDay >= maxPerDay) {
    return { ok: false, waitMs: 60 * 60 * 1000, reason: 'daily_cap' };
  }
  if (input.sentLastHour >= maxPerHour) {
    const oldest = input.oldestSentLastHour?.getTime();
    const waitMs = oldest ? Math.max(1000, oldest + 60 * 60 * 1000 - input.now.getTime()) : 60_000;
    return { ok: false, waitMs, reason: 'hourly_cap' };
  }
  if (input.lastSentAt && intervalMs > 0) {
    const elapsed = input.now.getTime() - input.lastSentAt.getTime();
    if (elapsed < intervalMs) {
      return { ok: false, waitMs: intervalMs - elapsed, reason: 'interval' };
    }
  }
  return { ok: true };
}

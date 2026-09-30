import { randomBytes } from 'crypto';

export interface MimeInput {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  unsubscribeUrl?: string | null;
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value)) return value.replace(/\r|\n/g, ' ');
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export function buildRawGmailMessage(input: MimeInput): string {
  const lines: string[] = [
    `From: ${encodeHeader(input.from)}`,
    `To: ${encodeHeader(input.to)}`,
    `Subject: ${encodeHeader(input.subject)}`,
    'MIME-Version: 1.0',
  ];
  if (input.unsubscribeUrl) {
    lines.push(`List-Unsubscribe: <${input.unsubscribeUrl}>`);
  }

  if (input.html) {
    const boundary = `npmo_${randomBytes(8).toString('hex')}`;
    lines.push(`Content-Type: multipart/alternative; boundary="${boundary}"`, '');
    lines.push(`--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', input.text);
    lines.push(`--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', input.html);
    lines.push(`--${boundary}--`);
  } else {
    lines.push('Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit', '', input.text);
  }

  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

export function extractHttpStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const record = error as { status?: number; code?: number | string; response?: { status?: number } };
  if (typeof record.status === 'number') return record.status;
  if (typeof record.response?.status === 'number') return record.response.status;
  if (typeof record.code === 'number') return record.code;
  return null;
}

export function isTransientError(error: unknown): boolean {
  const status = extractHttpStatus(error);
  if (status === 429 || status === 500 || status === 502 || status === 503 || status === 504) return true;
  const message = error instanceof Error ? error.message : String(error ?? '');
  return /timeout|etimedout|econnreset|eai_again|network|socket hang up|temporarily/i.test(message);
}

export function errorMessage(error: unknown): string {
  const status = extractHttpStatus(error);
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  const trimmed = message.replace(/\s+/g, ' ').trim().slice(0, 500);
  return status ? `HTTP ${status}: ${trimmed}` : trimmed;
}

import { IngestResponse } from '@npm-outreach/shared';
import { apiRequest } from './api';
import { CollectedEmail, Eligibility, roleFromSource } from './discovery';
import { loadSettings, PENDING_KEY, SAVE_KEY, applySavedRuntime, saveRuntime } from './storage';
import { createRuntime } from './discovery';

export function mapEligibility(value: IngestResponse['contacts'][number]['eligibility']): Eligibility {
  if (value === 'ALREADY_CONTACTED') return 'CONTACTED';
  if (value === 'SUPPRESSED') return 'SUPPRESSED';
  if (value === 'INVALID') return 'INVALID';
  return 'NEW';
}

export function toIngestPayload(rows: CollectedEmail[]) {
  return rows.map((row) => ({
    email: row.email,
    name: row.name,
    packageName: row.package,
    packageUrl: row.packageUrl,
    keyword: row.keyword,
    role: roleFromSource(row.source),
  }));
}

export function applyIngest(results: CollectedEmail[], response: IngestResponse): void {
  const byEmail = new Map(results.map((row) => [row.email.trim().toLowerCase(), row]));
  for (const item of response.contacts) {
    const row = byEmail.get(item.normalizedEmail) || byEmail.get(item.email.trim().toLowerCase());
    if (!row) continue;
    row.eligibility = mapEligibility(item.eligibility);
    if (item.contactId) row.contactId = item.contactId;
  }
}

export async function syncRows(rows: CollectedEmail[], results: CollectedEmail[]): Promise<IngestResponse> {
  const settings = await loadSettings();
  const response = await apiRequest<IngestResponse>(settings, '/api/contacts/ingest', {
    method: 'POST',
    body: JSON.stringify({ contacts: toIngestPayload(rows) }),
  });
  applyIngest(results, response);
  return response;
}

export async function syncStoredPending(): Promise<void> {
  const settings = await loadSettings();
  if (!settings.backendUrl || !settings.apiKey) return;
  const stored = await chrome.storage.local.get([SAVE_KEY, PENDING_KEY]);
  const runtime = createRuntime();
  if (stored[SAVE_KEY]) applySavedRuntime(runtime, stored[SAVE_KEY]);
  const pending = runtime.results.filter((row) => row.eligibility === 'PENDING_SYNC');
  if (!pending.length) return;
  const response = await syncRows(pending, runtime.results);
  runtime.logs.unshift(`[${new Date().toLocaleTimeString()}] Synced ${response.summary.received} contacts.`);
  runtime.logs = runtime.logs.slice(0, 300);
  await saveRuntime(runtime);
}

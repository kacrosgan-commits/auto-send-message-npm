import { CollectedEmail, CollectorRuntime, Eligibility } from './discovery';
import { Settings } from './api';

export const SAVE_KEY = 'npmPublicEmailCollectorV3';
export const SETTINGS_KEY = 'npmOutreachSettings';
export const PENDING_KEY = 'pendingBackendSync';

export const DEFAULT_SETTINGS: Settings = {
  backendUrl: 'http://localhost:3000',
  apiKey: '',
};

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const value = stored[SETTINGS_KEY] as Partial<Settings> | undefined;
  return {
    backendUrl: value?.backendUrl || DEFAULT_SETTINGS.backendUrl,
    apiKey: value?.apiKey || '',
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export function serializeRuntime(runtime: CollectorRuntime) {
  return {
    results: runtime.results,
    packageQueue: runtime.packageQueue,
    nextIndex: runtime.nextIndex,
    query: runtime.query,
    target: runtime.target,
    maxPackages: runtime.maxPackages,
    delay: runtime.delay,
    excludeAutomated: runtime.excludeAutomated,
    logs: runtime.logs,
    savedAt: Date.now(),
  };
}

export async function saveRuntime(runtime: CollectorRuntime): Promise<void> {
  await chrome.storage.local.set({ [SAVE_KEY]: serializeRuntime(runtime) });
  const pending = runtime.results.filter((row) => row.eligibility === 'PENDING_SYNC');
  await chrome.storage.local.set({ [PENDING_KEY]: pending });
}

export function applySavedRuntime(runtime: CollectorRuntime, saved: Partial<CollectorRuntime> & { packageQueue?: Array<string | { name: string; keyword: string }> }): void {
  runtime.results = Array.isArray(saved.results) ? saved.results.map(normalizeResult) : [];
  runtime.packageQueue = Array.isArray(saved.packageQueue)
    ? saved.packageQueue.map((item) => typeof item === 'string' ? { name: item, keyword: String(saved.query || '') } : { name: item.name, keyword: item.keyword || String(saved.query || '') })
    : [];
  runtime.nextIndex = Math.max(0, Number(saved.nextIndex || 0));
  runtime.query = String(saved.query || '');
  runtime.target = Number(saved.target || 500);
  runtime.maxPackages = Number(saved.maxPackages || 1500);
  runtime.delay = Number(saved.delay || 400);
  runtime.excludeAutomated = saved.excludeAutomated !== false;
  runtime.logs = Array.isArray(saved.logs) ? saved.logs.map(String) : [];
}

export async function loadRuntime(runtime: CollectorRuntime): Promise<boolean> {
  const stored = await chrome.storage.local.get(SAVE_KEY);
  const saved = stored[SAVE_KEY] as Parameters<typeof applySavedRuntime>[1] | undefined;
  if (!saved) return false;
  applySavedRuntime(runtime, saved);
  return true;
}

function normalizeResult(row: Partial<CollectedEmail>): CollectedEmail {
  const eligibility = row.eligibility || 'PENDING_SYNC';
  return {
    email: String(row.email || ''),
    name: String(row.name || ''),
    package: String(row.package || ''),
    source: String(row.source || ''),
    packageUrl: String(row.packageUrl || ''),
    keyword: String(row.keyword || ''),
    eligibility: isEligibility(eligibility) ? eligibility : 'PENDING_SYNC',
    contactId: row.contactId,
  };
}

function isEligibility(value: string): value is Eligibility {
  return ['PENDING_SYNC', 'NEW', 'CONTACTED', 'SUPPRESSED', 'INVALID'].includes(value);
}

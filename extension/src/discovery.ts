import { isNoreplyAddress, normalizeRole } from '@npm-outreach/shared';

export type Eligibility = 'PENDING_SYNC' | 'NEW' | 'CONTACTED' | 'SUPPRESSED' | 'INVALID';

export interface CollectedEmail {
  email: string;
  name: string;
  package: string;
  source: string;
  packageUrl: string;
  keyword: string;
  eligibility: Eligibility;
  contactId?: string;
}

export interface QueueItem {
  name: string;
  keyword: string;
}

export interface CollectorRuntime {
  running: boolean;
  paused: boolean;
  stopRequested: boolean;
  results: CollectedEmail[];
  packageQueue: QueueItem[];
  nextIndex: number;
  query: string;
  target: number;
  maxPackages: number;
  delay: number;
  excludeAutomated: boolean;
  logs: string[];
}

export function createRuntime(): CollectorRuntime {
  return {
    running: false,
    paused: false,
    stopRequested: false,
    results: [],
    packageQueue: [],
    nextIndex: 0,
    query: '',
    target: 500,
    maxPackages: 1500,
    delay: 400,
    excludeAutomated: true,
    logs: [],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isEmail(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function normalizePerson(person: unknown): { name: string; email: string; url: string } | null {
  if (!person) return null;
  if (typeof person === 'string') {
    const match = person.match(/^\s*(.*?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/);
    return { name: (match?.[1] || '').trim(), email: (match?.[2] || '').trim(), url: (match?.[3] || '').trim() };
  }
  if (typeof person === 'object') {
    const record = person as { name?: string; username?: string; email?: string; url?: string };
    return {
      name: String(record.name || record.username || '').trim(),
      email: String(record.email || '').trim(),
      url: String(record.url || '').trim(),
    };
  }
  return null;
}

function resultKey(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function packageUrlFor(pkg: string): string {
  if (!pkg) return '';
  return `https://www.npmjs.com/package/${encodeURIComponent(pkg).replace(/%2F/gi, '/')}`;
}

export function addEmail(
  runtime: CollectorRuntime,
  person: unknown,
  pkg: string,
  source: string,
  keyword: string,
): CollectedEmail | null {
  const parsed = normalizePerson(person);
  if (!parsed || !isEmail(parsed.email)) return null;
  if (runtime.excludeAutomated && isNoreplyAddress(parsed.email)) return null;
  const key = resultKey(parsed.email);
  if (runtime.results.some((row) => resultKey(row.email) === key)) return null;
  const row: CollectedEmail = {
    email: parsed.email.trim(),
    name: parsed.name || '',
    package: pkg || '',
    source,
    packageUrl: packageUrlFor(pkg),
    keyword,
    eligibility: 'PENDING_SYNC',
  };
  runtime.results.push(row);
  return row;
}

function addFromSearchPackage(runtime: CollectorRuntime, pkg: Record<string, unknown>, keyword: string): CollectedEmail[] {
  const name = String(pkg.name || '');
  if (!name) return [];
  const added: CollectedEmail[] = [];
  const push = (person: unknown, source: string) => {
    const row = addEmail(runtime, person, name, source, keyword);
    if (row) added.push(row);
  };
  push(pkg.publisher, 'search publisher');
  push(pkg.author, 'search author');
  for (const maintainer of Array.isArray(pkg.maintainers) ? pkg.maintainers : []) push(maintainer, 'search maintainer');
  return added;
}

function addFromVersionData(runtime: CollectorRuntime, pkg: string, data: Record<string, unknown> | null, prefix: string, keyword: string): CollectedEmail[] {
  if (!data) return [];
  const label = (value: string) => (prefix ? `${prefix} ${value}` : value);
  const added: CollectedEmail[] = [];
  const push = (person: unknown, source: string) => {
    const row = addEmail(runtime, person, pkg, source, keyword);
    if (row) added.push(row);
  };
  push(data.author, label('author'));
  push(data._npmUser, label('publisher'));
  for (const maintainer of Array.isArray(data.maintainers) ? data.maintainers : []) push(maintainer, label('maintainer'));
  for (const contributor of Array.isArray(data.contributors) ? data.contributors : []) push(contributor, label('contributor'));
  return added;
}

export function roleFromSource(source: string): string {
  return normalizeRole(source);
}

function addFromPackument(runtime: CollectorRuntime, pkg: string, data: Record<string, unknown>, keyword: string): CollectedEmail[] {
  const added = addFromVersionData(runtime, pkg, data, 'package', keyword);
  const tags = data['dist-tags'] as { latest?: string } | undefined;
  const versions = data.versions as Record<string, Record<string, unknown>> | undefined;
  const latest = tags?.latest;
  if (latest && versions?.[latest]) added.push(...addFromVersionData(runtime, pkg, versions[latest], 'latest', keyword));
  return added;
}

export function parseKeywords(raw: string): string[] {
  const text = String(raw || '').trim();
  if (!text) return [];
  const parts = /[\n,;]/.test(text) ? text.split(/[\n,;]+/) : text.split(/\s+/);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    const keyword = part.trim();
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(keyword);
    if (out.length >= 20) break;
  }
  return out;
}

async function fetchJson(url: string, retries = 2): Promise<unknown> {
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
    } catch (error) {
      if (attempt < retries) {
        attempt += 1;
        await sleep(750 * attempt);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Network error: ${message}`);
    }
    if (response.ok) return response.json();
    let body = '';
    try {
      body = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 350);
    } catch {
      body = '';
    }
    const detail = body ? ` — ${body}` : '';
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = Number(response.headers.get('retry-after') || 0);
      attempt += 1;
      await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * attempt);
      continue;
    }
    throw new Error(`HTTP ${response.status}${detail}`);
  }
}

export async function searchPage(keyword: string, from: number, desiredSize: number): Promise<{ data: { objects?: Array<{ package?: Record<string, unknown> }>; total?: number }; size: number }> {
  const sizes = [...new Set([Math.min(100, desiredSize), Math.min(50, desiredSize), Math.min(20, desiredSize)].filter((size) => size > 0))];
  let lastError: unknown = null;
  for (const size of sizes) {
    const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(keyword)}&size=${size}&from=${from}`;
    try {
      const data = await fetchJson(url) as { objects?: Array<{ package?: Record<string, unknown> }>; total?: number };
      return { data, size };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.startsWith('HTTP 400')) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('npm search failed');
}

function registryPackagePath(pkg: string): string {
  return encodeURIComponent(pkg).replace(/^%40/i, '@');
}

export interface DiscoveryHooks {
  log: (message: string) => void;
  onUpdate: () => void;
  onEmails: (rows: CollectedEmail[]) => void;
}

export async function discoverPackages(runtime: CollectorRuntime, hooks: DiscoveryHooks): Promise<void> {
  const keywords = parseKeywords(runtime.query);
  if (!keywords.length) throw new Error('No valid search keywords.');
  hooks.log(`Using ${keywords.length} keyword${keywords.length === 1 ? '' : 's'}: ${keywords.join(', ')}`);
  const seen = new Set(runtime.packageQueue.map((item) => item.name));
  const states = keywords.map((keyword) => ({ keyword, from: 0, total: Number.POSITIVE_INFINITY, done: false }));

  while (runtime.packageQueue.length < runtime.maxPackages && states.some((state) => !state.done) && !runtime.stopRequested) {
    let madeProgress = false;
    for (const state of states) {
      if (state.done || runtime.stopRequested || runtime.packageQueue.length >= runtime.maxPackages || runtime.results.length >= runtime.target) break;
      const remaining = runtime.maxPackages - runtime.packageQueue.length;
      hooks.log(`Searching "${state.keyword}" from result ${state.from + 1}...`);
      try {
        const { data } = await searchPage(state.keyword, state.from, Math.min(100, remaining));
        const objects = Array.isArray(data.objects) ? data.objects : [];
        state.total = Number.isFinite(Number(data.total)) ? Number(data.total) : state.total;
        if (!objects.length) {
          state.done = true;
          continue;
        }
        const added: CollectedEmail[] = [];
        for (const obj of objects) {
          const pkg = obj.package;
          if (!pkg?.name) continue;
          added.push(...addFromSearchPackage(runtime, pkg, state.keyword));
          const name = String(pkg.name);
          if (!seen.has(name)) {
            seen.add(name);
            runtime.packageQueue.push({ name, keyword: state.keyword });
            madeProgress = true;
          }
          if (runtime.packageQueue.length >= runtime.maxPackages || runtime.results.length >= runtime.target) break;
        }
        if (added.length) hooks.onEmails(added);
        state.from += objects.length;
        if (state.from >= state.total) state.done = true;
        hooks.onUpdate();
        await sleep(250);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        hooks.log(`Search keyword "${state.keyword}" failed: ${message}`);
        if (String(message).includes('400')) hooks.log(`Search for "${state.keyword}" returned 400; that keyword was skipped.`);
        state.done = true;
      }
    }
    if (runtime.results.length >= runtime.target) break;
    if (!madeProgress && states.every((state) => state.done)) break;
  }

  if (!runtime.packageQueue.length && runtime.results.length < runtime.target) {
    throw new Error('No packages were discovered. Try a single simple keyword such as react or typescript, then use Test npm connection.');
  }
  hooks.log(`Discovered ${runtime.packageQueue.length} unique package${runtime.packageQueue.length === 1 ? '' : 's'}.`);
}

export async function inspectPackage(runtime: CollectorRuntime, item: QueueItem): Promise<CollectedEmail[]> {
  const url = `https://registry.npmjs.org/${registryPackagePath(item.name)}`;
  const data = await fetchJson(url, 2) as Record<string, unknown>;
  return addFromPackument(runtime, item.name, data, item.keyword);
}

export async function testNpmConnection(): Promise<string> {
  const { data } = await searchPage('react', 0, 1);
  return String(data.objects?.[0]?.package?.name || '(no package returned)');
}

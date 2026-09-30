import { renderTemplate } from '@npm-outreach/shared';
import { ApiError, apiRequest, Settings } from './api';
import {
  CollectedEmail,
  CollectorRuntime,
  createRuntime,
  discoverPackages,
  inspectPackage,
  testNpmConnection,
} from './discovery';
import { loadRuntime, loadSettings, PENDING_KEY, SAVE_KEY, saveRuntime } from './storage';
import { syncRows } from './sync';

const $ = <T extends HTMLElement>(id: string) => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
};

const runtime: CollectorRuntime = createRuntime();
let settings: Settings = { backendUrl: 'http://localhost:3000', apiKey: '' };
let syncChain: Promise<void> = Promise.resolve();
let lastSyncError = '';
let contactPage = 1;
let contactFilter = '';
let contactSearch = '';
let selectedIds = new Set<string>();
let selectAllNew = false;
let activeCampaignId = '';
let activeCampaignStatus = '';

type ContactRow = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  packageName: string | null;
  sourceRole: string | null;
  firstDiscoveredAt: string;
  lastSentAt: string | null;
  suppressed: boolean;
};

type CampaignRow = {
  id: string;
  name: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  status: string;
  counts?: Record<string, number>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function toast(message: string, kind: 'ok' | 'error' = 'ok') {
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.textContent = message;
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), 4500);
}

function confirmModal(message: string, confirmLabel: string): Promise<boolean> {
  $('modalBody').textContent = message;
  $('modalConfirm').textContent = confirmLabel;
  $('modal').classList.remove('hidden');
  return new Promise((resolve) => {
    const cleanup = (value: boolean) => {
      $('modal').classList.add('hidden');
      $('modalConfirm').onclick = null;
      $('modalCancel').onclick = null;
      resolve(value);
    };
    $('modalConfirm').onclick = () => cleanup(true);
    $('modalCancel').onclick = () => cleanup(false);
  });
}

function log(message: string) {
  const stamp = new Date().toLocaleTimeString();
  runtime.logs.unshift(`[${stamp}] ${message}`);
  runtime.logs = runtime.logs.slice(0, 300);
  $('log').textContent = runtime.logs.join('\n');
}

function badge(eligibility: string): HTMLElement {
  const span = document.createElement('span');
  const key = eligibility.toLowerCase().replace(/_/g, '-');
  span.className = `status-badge ${key}`;
  span.textContent = eligibility === 'PENDING_SYNC' ? 'SYNCING' : eligibility;
  return span;
}

function setStatus(text: string) {
  $('status').textContent = text;
}

function countEligibility(kind: CollectedEmail['eligibility']): number {
  return runtime.results.filter((row) => row.eligibility === kind).length;
}

function renderResults() {
  const tbody = $('results');
  tbody.innerHTML = '';
  for (const row of runtime.results.slice().reverse()) {
    const tr = document.createElement('tr');
    const values = [row.email, row.name, row.package, row.source];
    values.forEach((value) => {
      const td = document.createElement('td');
      td.textContent = value || '';
      tr.appendChild(td);
    });
    const statusCell = document.createElement('td');
    statusCell.appendChild(badge(row.eligibility));
    tr.appendChild(statusCell);
    const linkCell = document.createElement('td');
    if (row.packageUrl) {
      const anchor = document.createElement('a');
      anchor.href = row.packageUrl;
      anchor.target = '_blank';
      anchor.rel = 'noreferrer';
      anchor.textContent = 'npm package';
      linkCell.appendChild(anchor);
    }
    tr.appendChild(linkCell);
    tbody.appendChild(tr);
  }
  $('resultSummary').textContent = `${runtime.results.length} unique result${runtime.results.length === 1 ? '' : 's'}`;
}

function render() {
  $('emailCount').textContent = String(runtime.results.length);
  $('packageCount').textContent = String(Math.min(runtime.nextIndex, runtime.packageQueue.length));
  $('discoveredCount').textContent = String(runtime.packageQueue.length);
  $('newCount').textContent = String(countEligibility('NEW'));
  $('contactedCountStat').textContent = String(countEligibility('CONTACTED'));
  $('suppressedCountStat').textContent = String(countEligibility('SUPPRESSED'));
  $('invalidCountStat').textContent = String(countEligibility('INVALID'));
  const target = Math.max(1, runtime.target || Number(($('target') as HTMLSelectElement).value) || 500);
  const pct = Math.min(100, Math.round((runtime.results.length / target) * 100));
  $('percent').textContent = `${pct}%`;
  $('bar').style.width = `${pct}%`;
  const inspected = Math.min(runtime.nextIndex, runtime.packageQueue.length);
  if (runtime.running) {
    const pkg = runtime.packageQueue[runtime.nextIndex]?.name || '';
    $('progressText').textContent = `${runtime.results.length}/${target} emails · package ${Math.min(runtime.nextIndex + 1, runtime.packageQueue.length)}/${runtime.packageQueue.length}${pkg ? ` · ${pkg}` : ''}`;
  } else if (runtime.results.length || runtime.packageQueue.length) {
    $('progressText').textContent = `${runtime.results.length}/${target} emails · ${inspected}/${runtime.packageQueue.length} packages inspected`;
  } else {
    $('progressText').textContent = 'No collection running.';
  }
  ($('copy') as HTMLButtonElement).disabled = runtime.results.length === 0;
  ($('csv') as HTMLButtonElement).disabled = runtime.results.length === 0;
  $('log').textContent = runtime.logs.join('\n');
  renderResults();
  setControlState();
}

function setControlState() {
  const savedResume = !runtime.running && runtime.packageQueue.length > 0 && runtime.nextIndex < runtime.packageQueue.length && runtime.results.length < runtime.target;
  ($('start') as HTMLButtonElement).disabled = runtime.running;
  ($('pause') as HTMLButtonElement).disabled = !runtime.running || runtime.paused;
  ($('resume') as HTMLButtonElement).disabled = runtime.running ? !runtime.paused : !savedResume;
  ($('stop') as HTMLButtonElement).disabled = !runtime.running;
  ($('query') as HTMLInputElement).disabled = runtime.running;
  ($('target') as HTMLSelectElement).disabled = runtime.running;
  ($('maxPackages') as HTMLSelectElement).disabled = runtime.running;
  ($('delay') as HTMLSelectElement).disabled = runtime.running;
  ($('excludeAutomated') as HTMLInputElement).disabled = runtime.running;
  ($('testConnection') as HTMLButtonElement).disabled = runtime.running;
}

async function waitIfPaused() {
  while (runtime.paused && !runtime.stopRequested) await sleep(250);
}

function queueSync() {
  syncChain = syncChain.then(() => flushSync()).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== lastSyncError) {
      lastSyncError = message;
      log(`Backend sync failed: ${message}. Collected emails stay saved locally and will retry.`);
    }
  });
}

async function flushSync() {
  const pending = runtime.results.filter((row) => row.eligibility === 'PENDING_SYNC');
  if (!pending.length) return;
  if (!settings.backendUrl || !settings.apiKey) {
    log('Backend settings are incomplete. Emails are saved locally until Settings has a URL and API key.');
    return;
  }
  const chunk = pending.slice(0, 200);
  const response = await syncRows(chunk, runtime.results);
  lastSyncError = '';
  log(`Synced ${response.summary.received} contacts.`);
  log(`${response.summary.new} new eligible.`);
  log(`${response.summary.alreadyContacted} already contacted.`);
  log(`${response.summary.suppressed} suppressed.`);
  if (response.summary.invalid) log(`${response.summary.invalid} invalid.`);
  await saveRuntime(runtime);
  render();
  if (runtime.results.some((row) => row.eligibility === 'PENDING_SYNC')) queueSync();
}

async function runCollection(resume: boolean) {
  if (runtime.running) return;
  if (!resume) {
    const query = ($('query') as HTMLInputElement).value.trim();
    if (!query) {
      toast('Enter at least one npm search keyword first.', 'error');
      ($('query') as HTMLInputElement).focus();
      return;
    }
    runtime.results = [];
    runtime.packageQueue = [];
    runtime.nextIndex = 0;
    runtime.logs = [];
    runtime.query = query;
    runtime.target = Number(($('target') as HTMLSelectElement).value);
    runtime.maxPackages = Number(($('maxPackages') as HTMLSelectElement).value);
    runtime.delay = Number(($('delay') as HTMLSelectElement).value);
    runtime.excludeAutomated = ($('excludeAutomated') as HTMLInputElement).checked;
  }
  runtime.running = true;
  runtime.paused = false;
  runtime.stopRequested = false;
  render();
  await saveRuntime(runtime);
  const hooks = {
    log,
    onUpdate: () => { render(); void saveRuntime(runtime); },
    onEmails: () => queueSync(),
  };
  try {
    if (!runtime.packageQueue.length && runtime.results.length < runtime.target) {
      setStatus('Discovering');
      await discoverPackages(runtime, hooks);
    }
    if (runtime.results.length >= runtime.target) {
      setStatus('Complete');
      log(`Target reached from npm search metadata: ${runtime.results.length} unique emails.`);
      return;
    }
    setStatus('Collecting');
    for (; runtime.nextIndex < runtime.packageQueue.length; runtime.nextIndex += 1) {
      if (runtime.stopRequested) break;
      await waitIfPaused();
      if (runtime.stopRequested) break;
      if (runtime.results.length >= runtime.target) break;
      const item = runtime.packageQueue[runtime.nextIndex];
      try {
        const added = await inspectPackage(runtime, item);
        if (added.length) {
          log(`${item.name}: +${added.length} unique public email${added.length === 1 ? '' : 's'}.`);
          hooks.onEmails();
        }
      } catch (error) {
        log(`${item.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
      render();
      if (runtime.nextIndex % 10 === 0) await saveRuntime(runtime);
      if (runtime.delay > 0) await sleep(runtime.delay);
    }
    if (runtime.stopRequested) {
      setStatus('Stopped');
      log('Collection stopped. Progress was saved.');
    } else if (runtime.results.length >= runtime.target) {
      setStatus('Complete');
      log(`Target reached: ${runtime.results.length} unique public emails.`);
    } else if (runtime.nextIndex >= runtime.packageQueue.length) {
      setStatus('Finished');
      log(`Finished available package queue with ${runtime.results.length} unique emails.`);
    }
  } catch (error) {
    setStatus('Error');
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    runtime.running = false;
    runtime.paused = false;
    await saveRuntime(runtime);
    queueSync();
    render();
  }
}

function showTab(name: string) {
  document.querySelectorAll<HTMLElement>('[data-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.panel !== name;
  });
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  if (name === 'contacts') void loadContacts();
  if (name === 'campaigns') void loadCampaigns();
  if (name === 'gmail') void loadGmail();
  if (name === 'history') void loadHistory();
}

function formatDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
}

async function loadContacts() {
  const tbody = $('contactsBody');
  tbody.innerHTML = '';
  try {
    const params = new URLSearchParams({ page: String(contactPage), limit: '25' });
    if (contactFilter === 'SUPPRESSED') params.set('suppressed', 'true');
    else if (contactFilter) params.set('status', contactFilter);
    if (contactSearch) params.set('search', contactSearch);
    if (contactFilter === 'NEW') params.set('contacted', 'false');
    const data = await apiRequest<{ contacts: ContactRow[]; total: number; page: number; limit: number }>(settings, `/api/contacts?${params.toString()}`);
    if (!data.contacts.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 8;
      td.className = 'empty';
      td.textContent = 'No contacts match this filter.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const contact of data.contacts) {
      const tr = document.createElement('tr');
      const check = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = selectAllNew ? contact.status === 'NEW' && !contact.suppressed : selectedIds.has(contact.id);
      input.disabled = contact.status !== 'NEW' || contact.suppressed;
      input.addEventListener('change', () => {
        selectAllNew = false;
        if (input.checked) selectedIds.add(contact.id);
        else selectedIds.delete(contact.id);
        renderSelectionHint();
      });
      check.appendChild(input);
      tr.appendChild(check);
      for (const value of [contact.email, contact.name || '', contact.packageName || '', contact.sourceRole || '']) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      const status = document.createElement('td');
      status.appendChild(badge(contact.suppressed && contact.status !== 'CONTACTED' ? 'SUPPRESSED' : contact.status));
      tr.appendChild(status);
      const discovered = document.createElement('td');
      discovered.textContent = formatDate(contact.firstDiscoveredAt);
      tr.appendChild(discovered);
      const sent = document.createElement('td');
      sent.textContent = formatDate(contact.lastSentAt);
      tr.appendChild(sent);
      tbody.appendChild(tr);
    }
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    $('contactPageLabel').textContent = `Page ${data.page} of ${pages} · ${data.total} contacts`;
    ($('contactPrev') as HTMLButtonElement).disabled = data.page <= 1;
    ($('contactNext') as HTMLButtonElement).disabled = data.page >= pages;
  } catch (error) {
    showApiError(error);
  }
}

function renderSelectionHint() {
  $('selectionHint').textContent = selectAllNew
    ? 'All NEW contacts will be reviewed when you queue a campaign.'
    : `${selectedIds.size} contact${selectedIds.size === 1 ? '' : 's'} selected.`;
}

async function loadCampaigns() {
  const list = $('campaignList');
  list.innerHTML = '';
  try {
    const data = await apiRequest<{ campaigns: CampaignRow[] }>(settings, '/api/campaigns');
    if (!data.campaigns.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No campaigns yet.';
      list.appendChild(empty);
    }
    for (const campaign of data.campaigns) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `campaignItem${campaign.id === activeCampaignId ? ' active' : ''}`;
      const sent = campaign.counts?.SENT || 0;
      button.textContent = `${campaign.name} · ${campaign.status} · ${sent} sent`;
      button.addEventListener('click', () => {
        activeCampaignId = campaign.id;
        activeCampaignStatus = campaign.status;
        ($('campaignName') as HTMLInputElement).value = campaign.name;
        ($('campaignSubject') as HTMLInputElement).value = campaign.subject;
        ($('campaignBody') as HTMLTextAreaElement).value = campaign.bodyText;
        updatePreview();
        void loadCampaigns();
        void loadCampaignDetail();
      });
      list.appendChild(button);
    }
  } catch (error) {
    showApiError(error);
  }
  if (activeCampaignId) await loadCampaignDetail();
}

function updatePreview() {
  const subject = ($('campaignSubject') as HTMLInputElement).value;
  const body = ($('campaignBody') as HTMLTextAreaElement).value;
  const renderedSubject = renderTemplate(subject, { name: 'Ada Lovelace', firstName: 'Ada', email: 'ada@example.com', package: 'example-package', packageUrl: 'https://www.npmjs.com/package/example-package' });
  const renderedBody = renderTemplate(body, { name: 'Ada Lovelace', firstName: 'Ada', email: 'ada@example.com', package: 'example-package', packageUrl: 'https://www.npmjs.com/package/example-package' });
  $('previewSubject').textContent = renderedSubject.text || 'Subject preview';
  $('previewBody').textContent = renderedBody.text || 'Body preview';
}

async function saveCampaign(): Promise<string> {
  const payload = {
    name: ($('campaignName') as HTMLInputElement).value.trim(),
    subject: ($('campaignSubject') as HTMLInputElement).value.trim(),
    bodyText: ($('campaignBody') as HTMLTextAreaElement).value.trim(),
  };
  if (!payload.name || !payload.subject || !payload.bodyText) {
    throw new ApiError(0, 'VALIDATION', 'Campaign name, subject, and body are required.');
  }
  if (activeCampaignId && activeCampaignStatus !== 'COMPLETED' && activeCampaignStatus !== 'CANCELLED') {
    await apiRequest(settings, `/api/campaigns/${activeCampaignId}`, { method: 'PATCH', body: JSON.stringify(payload) });
    return activeCampaignId;
  }
  const created = await apiRequest<{ campaign: CampaignRow }>(settings, '/api/campaigns', { method: 'POST', body: JSON.stringify(payload) });
  activeCampaignId = created.campaign.id;
  activeCampaignStatus = created.campaign.status || 'DRAFT';
  log(`Campaign created: ${created.campaign.name}`);
  return created.campaign.id;
}

async function reviewAndQueue() {
  try {
    if (!selectAllNew && selectedIds.size === 0) {
      toast('Open Contacts and click Select all new, or check the people you want to email.', 'error');
      return;
    }
    const id = await saveCampaign();
    const body = selectAllNew
      ? { filter: { status: 'NEW' } }
      : { contactIds: [...selectedIds] };
    const preview = await apiRequest<{
      selected: number;
      eligible: number;
      alreadyContacted: number;
      suppressed: number;
      invalid: number;
      alreadyQueued: number;
      readyToQueue: number;
    }>(settings, `/api/campaigns/${id}/recipients`, { method: 'POST', body: JSON.stringify(body) });
    $('reviewSelected').textContent = String(preview.selected);
    $('reviewContacted').textContent = String(preview.alreadyContacted);
    $('reviewSuppressed').textContent = String(preview.suppressed);
    $('reviewInvalid').textContent = String(preview.invalid);
    $('reviewEligible').textContent = String(preview.readyToQueue);
    const ready = preview.readyToQueue;
    if (ready <= 0) {
      toast('No eligible recipients to queue. Previously contacted and suppressed addresses were excluded.', 'error');
      await loadCampaignDetail();
      return;
    }
    const confirmed = await confirmModal(
      `You are about to queue ${ready} eligible recipients. Previously contacted and suppressed addresses will be excluded.`,
      `Queue ${ready} recipients`,
    );
    if (!confirmed) {
      log('Queue cancelled.');
      return;
    }
    const queued = await apiRequest<{ queued: number; status: string }>(settings, `/api/campaigns/${id}/queue`, { method: 'POST', body: '{}' });
    log(`Queued ${queued.queued} recipients. Status: ${queued.status}.`);
    toast(`Queued ${queued.queued} recipients.`);
    await loadCampaigns();
    await loadCampaignDetail();
  } catch (error) {
    showApiError(error);
  }
}

async function loadCampaignDetail() {
  const panel = $('campaignDetail');
  if (!activeCampaignId) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  try {
    const data = await apiRequest<{
      campaign: CampaignRow;
      counts: Record<string, number>;
      recipients: { items: Array<{ email: string; name: string | null; packageName: string | null; status: string; sentAt: string | null; lastError: string | null }>; total: number };
    }>(settings, `/api/campaigns/${activeCampaignId}?limit=50`);
    activeCampaignStatus = data.campaign.status;
    $('detailName').textContent = data.campaign.name;
    $('detailStatus').textContent = data.campaign.status;
    $('detailStatus').className = `status-badge ${data.campaign.status.toLowerCase()}`;
    const counts = data.counts;
    const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const sent = counts.SENT || 0;
    const pct = total ? Math.round((sent / total) * 100) : 0;
    $('detailBar').style.width = `${pct}%`;
    $('detailProgress').textContent = `${sent}/${total} sent`;
    const labels: Array<[string, number]> = [
      ['Eligible', (counts.PENDING || 0)],
      ['Queued', counts.QUEUED || 0],
      ['Processing', counts.PROCESSING || 0],
      ['Sent', counts.SENT || 0],
      ['Failed', counts.FAILED || 0],
      ['Skipped', counts.SKIPPED || 0],
    ];
    $('detailCounts').innerHTML = '';
    for (const [label, value] of labels) {
      const item = document.createElement('div');
      item.className = 'stat mini';
      const strong = document.createElement('strong');
      strong.textContent = String(value);
      const span = document.createElement('span');
      span.textContent = label;
      item.append(strong, span);
      $('detailCounts').appendChild(item);
    }
    const status = data.campaign.status;
    ($('campaignStart') as HTMLButtonElement).disabled = status === 'COMPLETED' || status === 'CANCELLED';
    ($('campaignPause') as HTMLButtonElement).disabled = status !== 'RUNNING' && status !== 'QUEUED';
    ($('campaignResume') as HTMLButtonElement).disabled = status !== 'PAUSED';
    ($('campaignCancel') as HTMLButtonElement).disabled = status === 'COMPLETED' || status === 'CANCELLED';
    const tbody = $('campaignRecipients');
    tbody.innerHTML = '';
    if (!data.recipients.items.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = 'No recipients queued yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const row of data.recipients.items) {
      const tr = document.createElement('tr');
      for (const value of [row.email, row.name || '', row.packageName || '']) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      const statusCell = document.createElement('td');
      statusCell.appendChild(badge(row.status));
      tr.appendChild(statusCell);
      const sentAt = document.createElement('td');
      sentAt.textContent = formatDate(row.sentAt);
      tr.appendChild(sentAt);
      const error = document.createElement('td');
      error.textContent = row.lastError || '';
      tr.appendChild(error);
      tbody.appendChild(tr);
    }
  } catch (error) {
    showApiError(error);
  }
}

async function campaignAction(action: 'start' | 'pause' | 'resume' | 'cancel') {
  if (action === 'start' && (selectAllNew || selectedIds.size > 0)) {
    await reviewAndQueue();
    return;
  }
  if (!activeCampaignId) return;
  try {
    await apiRequest(settings, `/api/campaigns/${activeCampaignId}/${action}`, { method: 'POST', body: '{}' });
    log(`Campaign ${action}.`);
    await loadCampaignDetail();
    await loadCampaigns();
  } catch (error) {
    showApiError(error);
  }
}

async function loadGmail() {
  try {
    const account = await apiRequest<{ connected: boolean; email?: string }>(settings, '/api/gmail/account');
    $('gmailState').textContent = account.connected ? 'Connected' : 'Not connected';
    $('gmailState').className = `status-badge ${account.connected ? 'contacted' : 'pending-sync'}`;
    $('gmailEmail').textContent = account.connected ? account.email || '' : 'Connect a Gmail account before queueing a campaign.';
    ($('connectGmail') as HTMLButtonElement).hidden = account.connected;
    ($('disconnectGmail') as HTMLButtonElement).hidden = !account.connected;
  } catch (error) {
    $('gmailState').textContent = 'Unavailable';
    $('gmailEmail').textContent = error instanceof Error ? error.message : String(error);
    ($('connectGmail') as HTMLButtonElement).hidden = false;
    ($('disconnectGmail') as HTMLButtonElement).hidden = true;
  }
}

async function loadHistory() {
  const tbody = $('historyBody');
  tbody.innerHTML = '';
  try {
    const params = new URLSearchParams({
      page: ($('historyPage') as HTMLInputElement).value || '1',
      limit: '25',
    });
    const search = ($('historySearch') as HTMLInputElement).value.trim();
    if (search) params.set('search', search);
    const data = await apiRequest<{
      page: number;
      total: number;
      limit: number;
      items: Array<{ email: string; campaignName: string; packageName: string | null; sentAt: string | null; gmailMessageId: string | null; status: string }>;
    }>(settings, `/api/history?${params.toString()}`);
    if (!data.items.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 6;
      td.className = 'empty';
      td.textContent = 'No send history yet.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    for (const item of data.items) {
      const tr = document.createElement('tr');
      for (const value of [item.email, item.campaignName, item.packageName || '', formatDate(item.sentAt), item.gmailMessageId || '']) {
        const td = document.createElement('td');
        td.textContent = value;
        tr.appendChild(td);
      }
      const status = document.createElement('td');
      status.appendChild(badge(item.status));
      tr.appendChild(status);
      tbody.appendChild(tr);
    }
    const pages = Math.max(1, Math.ceil(data.total / data.limit));
    $('historyPageLabel').textContent = `Page ${data.page} of ${pages}`;
    ($('historyPage') as HTMLInputElement).value = String(data.page);
    ($('historyPrev') as HTMLButtonElement).disabled = data.page <= 1;
    ($('historyNext') as HTMLButtonElement).disabled = data.page >= pages;
  } catch (error) {
    showApiError(error);
  }
}

function showApiError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  log(message);
  toast(message, 'error');
}

function bind() {
  document.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => showTab(button.dataset.tab || 'discovery'));
  });
  $('start').addEventListener('click', () => void runCollection(false));
  $('pause').addEventListener('click', () => {
    runtime.paused = true;
    setStatus('Paused');
    setControlState();
    log('Paused.');
    void saveRuntime(runtime);
  });
  $('resume').addEventListener('click', () => {
    if (runtime.running && runtime.paused) {
      runtime.paused = false;
      setStatus('Collecting');
      setControlState();
      log('Resumed.');
      return;
    }
    if (!runtime.running && runtime.packageQueue.length && runtime.nextIndex < runtime.packageQueue.length) void runCollection(true);
  });
  $('stop').addEventListener('click', () => {
    runtime.stopRequested = true;
    runtime.paused = false;
    setStatus('Stopping');
    log('Stop requested...');
  });
  $('clearSaved').addEventListener('click', async () => {
    if (runtime.running) return;
    const ok = await confirmModal('Clear the saved collection and its local results?', 'Clear saved job');
    if (!ok) return;
    await chrome.storage.local.remove([SAVE_KEY, PENDING_KEY]);
    runtime.results = [];
    runtime.packageQueue = [];
    runtime.nextIndex = 0;
    runtime.logs = [];
    runtime.query = '';
    ($('query') as HTMLInputElement).value = '';
    setStatus('Idle');
    render();
  });
  $('clearLog').addEventListener('click', () => {
    runtime.logs = [];
    $('log').textContent = '';
    void saveRuntime(runtime);
  });
  $('testConnection').addEventListener('click', async () => {
    ($('testConnection') as HTMLButtonElement).disabled = true;
    setStatus('Testing');
    log('Testing public npm registry search endpoint with keyword "react"...');
    try {
      const name = await testNpmConnection();
      setStatus('Connection OK');
      log(`npm connection OK. First package returned: ${name}`);
    } catch (error) {
      setStatus('Connection error');
      log(`npm connection test failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ($('testConnection') as HTMLButtonElement).disabled = false;
    }
  });
  $('copy').addEventListener('click', async () => {
    const emails = runtime.results.map((row) => row.email);
    await navigator.clipboard.writeText(emails.join('\n'));
    log(`Copied ${emails.length} unique emails.`);
    toast(`Copied ${emails.length} emails.`);
  });
  $('csv').addEventListener('click', () => {
    const quote = (value: string) => `"${String(value ?? '').replace(/"/g, '""')}"`;
    const lines = [['email', 'name', 'package', 'source', 'package_url', 'search_query', 'eligibility'].map(quote).join(',')];
    for (const row of runtime.results) {
      lines.push([row.email, row.name, row.package, row.source, row.packageUrl, runtime.query, row.eligibility].map(quote).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `npm-public-emails-${runtime.results.length}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  });
  $('openSettings').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('contactSearchBtn').addEventListener('click', () => {
    contactSearch = ($('contactSearch') as HTMLInputElement).value.trim();
    contactPage = 1;
    void loadContacts();
  });
  $('contactFilter').addEventListener('change', () => {
    contactFilter = ($('contactFilter') as HTMLSelectElement).value;
    contactPage = 1;
    void loadContacts();
  });
  $('contactPrev').addEventListener('click', () => { contactPage = Math.max(1, contactPage - 1); void loadContacts(); });
  $('contactNext').addEventListener('click', () => { contactPage += 1; void loadContacts(); });
  $('selectAllNew').addEventListener('click', () => {
    selectAllNew = true;
    selectedIds = new Set();
    renderSelectionHint();
    void loadContacts();
    toast('All NEW contacts will be used for the next campaign review.');
  });
  $('clearSelection').addEventListener('click', () => {
    selectAllNew = false;
    selectedIds = new Set();
    renderSelectionHint();
    void loadContacts();
  });
  ['campaignSubject', 'campaignBody', 'campaignName'].forEach((id) => {
    $(id).addEventListener('input', updatePreview);
  });
  $('saveCampaign').addEventListener('click', async () => {
    try {
      await saveCampaign();
      toast('Campaign saved.');
      await loadCampaigns();
    } catch (error) {
      showApiError(error);
    }
  });
  $('newCampaign').addEventListener('click', () => {
    activeCampaignId = '';
    activeCampaignStatus = '';
    ($('campaignName') as HTMLInputElement).value = '';
    ($('campaignSubject') as HTMLInputElement).value = '';
    ($('campaignBody') as HTMLTextAreaElement).value = 'Hi {{firstName}},\n\nI came across your work on {{package}}.\n';
    $('campaignDetail').hidden = true;
    updatePreview();
    void loadCampaigns();
  });
  $('queueCampaign').addEventListener('click', () => void reviewAndQueue());
  $('campaignStart').addEventListener('click', () => void campaignAction('start'));
  $('campaignPause').addEventListener('click', () => void campaignAction('pause'));
  $('campaignResume').addEventListener('click', () => void campaignAction('resume'));
  $('campaignCancel').addEventListener('click', async () => {
    const ok = await confirmModal('Cancel this campaign? Recipients that have not been sent will be skipped.', 'Cancel campaign');
    if (ok) await campaignAction('cancel');
  });
  $('connectGmail').addEventListener('click', async () => {
    try {
      const result = await apiRequest<{ url: string }>(settings, '/api/auth/google', { headers: { Accept: 'application/json' } });
      await chrome.tabs.create({ url: result.url });
      toast('Finish the Google consent screen, then return here.');
    } catch (error) {
      showApiError(error);
    }
  });
  $('disconnectGmail').addEventListener('click', async () => {
    const ok = await confirmModal('Disconnect the Gmail account? Refresh tokens will be removed from the server.', 'Disconnect');
    if (!ok) return;
    try {
      await apiRequest(settings, '/api/gmail/disconnect', { method: 'POST', body: '{}' });
      toast('Gmail disconnected.');
      await loadGmail();
    } catch (error) {
      showApiError(error);
    }
  });
  $('historySearchBtn').addEventListener('click', () => {
    ($('historyPage') as HTMLInputElement).value = '1';
    void loadHistory();
  });
  $('historyPrev').addEventListener('click', () => {
    const input = $('historyPage') as HTMLInputElement;
    input.value = String(Math.max(1, Number(input.value || '1') - 1));
    void loadHistory();
  });
  $('historyNext').addEventListener('click', () => {
    const input = $('historyPage') as HTMLInputElement;
    input.value = String(Number(input.value || '1') + 1);
    void loadHistory();
  });
  window.addEventListener('focus', () => {
    const active = document.querySelector<HTMLButtonElement>('[data-tab].active');
    if (active?.dataset.tab === 'gmail') void loadGmail();
  });
  window.setInterval(() => {
    const active = document.querySelector<HTMLButtonElement>('[data-tab].active');
    if (active?.dataset.tab === 'campaigns' && activeCampaignId) void loadCampaignDetail();
  }, 4000);
  window.setInterval(() => {
    if (runtime.results.some((row) => row.eligibility === 'PENDING_SYNC')) queueSync();
  }, 20000);
}

async function init() {
  settings = await loadSettings();
  const loaded = await loadRuntime(runtime);
  if (runtime.query) ($('query') as HTMLInputElement).value = runtime.query;
  ($('target') as HTMLSelectElement).value = String(runtime.target);
  ($('maxPackages') as HTMLSelectElement).value = String(runtime.maxPackages);
  ($('delay') as HTMLSelectElement).value = String(runtime.delay);
  ($('excludeAutomated') as HTMLInputElement).checked = runtime.excludeAutomated;
  ($('campaignBody') as HTMLTextAreaElement).value = 'Hi {{firstName}},\n\nI came across your work on {{package}}.\n';
  updatePreview();
  renderSelectionHint();
  if (loaded) {
    const canResume = runtime.packageQueue.length > 0 && runtime.nextIndex < runtime.packageQueue.length && runtime.results.length < runtime.target;
    setStatus(canResume ? 'Saved job' : runtime.results.length ? 'Saved' : 'Idle');
    if (canResume) log('Saved job loaded. Click Resume to continue.');
  }
  bind();
  render();
  queueSync();
}

void init();

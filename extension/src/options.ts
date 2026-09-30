import { testBackendConnection } from './api';
import { loadSettings, saveSettings } from './storage';

const backendUrl = document.getElementById('backendUrl') as HTMLInputElement;
const apiKey = document.getElementById('apiKey') as HTMLInputElement;
const result = document.getElementById('result') as HTMLParagraphElement;

async function init() {
  const settings = await loadSettings();
  backendUrl.value = settings.backendUrl;
  apiKey.value = settings.apiKey;
}

document.getElementById('save')?.addEventListener('click', async () => {
  await saveSettings({ backendUrl: backendUrl.value.trim(), apiKey: apiKey.value.trim() });
  result.textContent = 'Saved.';
});

document.getElementById('test')?.addEventListener('click', async () => {
  result.textContent = 'Testing...';
  const settings = { backendUrl: backendUrl.value.trim(), apiKey: apiKey.value.trim() };
  try {
    const message = await testBackendConnection(settings);
    await saveSettings(settings);
    result.textContent = message;
  } catch (error) {
    result.textContent = error instanceof Error ? error.message : String(error);
  }
});

void init();

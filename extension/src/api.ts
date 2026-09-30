export interface Settings {
  backendUrl: string;
  apiKey: string;
}

export interface ApiErrorBody {
  error?: { code?: string; message?: string; details?: unknown };
}

export class ApiError extends Error {
  code: string;
  details: unknown;
  status: number;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details ?? {};
  }
}

export function normalizeBackendUrl(url: string): string {
  return url.trim().replace(/\/$/, '');
}

export async function apiRequest<T>(settings: Settings, path: string, init: RequestInit = {}): Promise<T> {
  const base = normalizeBackendUrl(settings.backendUrl);
  if (!base) throw new ApiError(0, 'NO_BACKEND', 'Set the backend URL in Settings.');
  if (!settings.apiKey.trim()) throw new ApiError(0, 'NO_API_KEY', 'Set the backend API key in Settings.');
  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
        ...(init.headers || {}),
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, 'NETWORK', `Cannot reach the backend: ${message}`);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = { error: { message: text.slice(0, 300) } }; }
  }
  if (!response.ok) {
    const payload = body as ApiErrorBody;
    throw new ApiError(
      response.status,
      payload?.error?.code || `HTTP_${response.status}`,
      payload?.error?.message || `Request failed (${response.status})`,
      payload?.error?.details,
    );
  }
  return body as T;
}

export async function testBackendConnection(settings: Settings): Promise<string> {
  const base = normalizeBackendUrl(settings.backendUrl);
  if (!base) throw new ApiError(0, 'NO_BACKEND', 'Enter a backend URL.');
  let health: Response;
  try {
    health = await fetch(`${base}/api/health`, { headers: { Accept: 'application/json' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ApiError(0, 'NETWORK', `Cannot reach ${base}. ${message}`);
  }
  if (!health.ok) throw new ApiError(health.status, 'HEALTH', `Health check failed (${health.status}).`);
  if (!settings.apiKey.trim()) throw new ApiError(0, 'NO_API_KEY', 'Server is reachable. Add an API key to authenticate.');
  await apiRequest(settings, '/api/gmail/account');
  return 'Connected';
}

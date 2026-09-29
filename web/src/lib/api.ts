import { readSSE } from '../../../shared/sse';
import type {
  Capabilities,
  ChatRequest,
  ConversationDetail,
  ConversationSummary,
  StreamEvent,
  UserProfile,
} from '../../../shared/types';

const TOKEN_KEY = 'tralix.token';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let sessionPromise: Promise<string> | null = null;

async function createSession(): Promise<string> {
  const res = await fetch('/api/session', { method: 'POST' });
  if (!res.ok) throw new ApiError(res.status, 'Could not start a session. Please reload the page.');
  const { token } = (await res.json()) as { token: string };
  localStorage.setItem(TOKEN_KEY, token);
  return token;
}

async function getToken(fresh = false): Promise<string> {
  if (!fresh) {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
  }
  sessionPromise ??= createSession().finally(() => (sessionPromise = null));
  return sessionPromise;
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const go = async (fresh: boolean) => {
    const token = await getToken(fresh);
    return fetch(`/api${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
    });
  };
  let res = await go(false);
  if (res.status === 401) res = await go(true); // stale token → new anonymous session
  return res;
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await authFetch(path, init);
  } catch {
    throw new ApiError(0, 'Network error. Check your connection and try again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(res.status, (body as { error?: string }).error ?? 'Something went wrong.');
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  capabilities: () => fetch('/api/capabilities').then((r) => r.json() as Promise<Capabilities>),
  me: () => json<UserProfile>('/me'),
  updateMe: (patch: Partial<Pick<UserProfile, 'displayName' | 'customInstructions'>>) =>
    json<UserProfile>('/me', { method: 'PATCH', body: JSON.stringify(patch) }),
  listConversations: (q?: string) =>
    json<ConversationSummary[]>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getConversation: (id: string) => json<ConversationDetail>(`/conversations/${id}`),
  renameConversation: (id: string, title: string) =>
    json<ConversationSummary>(`/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteConversation: (id: string) => json<void>(`/conversations/${id}`, { method: 'DELETE' }),
  deleteAllConversations: () => json<{ deleted: number }>('/conversations', { method: 'DELETE' }),
};

/**
 * Start a streaming chat request. Resolves with an async iterator of events, or
 * throws ApiError (with a user-safe message) if the request was rejected.
 */
export async function* streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  let res: Response;
  try {
    res = await authFetch('/chat', { method: 'POST', body: JSON.stringify(req), signal });
  } catch (e) {
    if (signal.aborted) return;
    throw new ApiError(0, 'Network error. Check your connection and try again.');
  }
  if (!res.ok || !res.body) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, body.error ?? 'Something went wrong. Please try again.');
  }
  try {
    for await (const m of readSSE(res.body)) {
      try {
        yield JSON.parse(m.data) as StreamEvent;
      } catch {
        /* ignore malformed event */
      }
    }
  } catch (e) {
    if (signal.aborted) return;
    throw new ApiError(0, 'The connection was interrupted. Please try again.');
  }
}

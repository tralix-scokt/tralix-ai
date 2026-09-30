import { readSSE } from '../../../shared/sse';
import type {
  Attachment,
  Capabilities,
  ChatRequest,
  ConversationDetail,
  ConversationSummary,
  MemoryItem,
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

async function createAnonymousSession(): Promise<string> {
  const res = await fetch('/api/session', {
    method: 'POST',
    credentials: 'include',
  });
  if (!res.ok) throw new ApiError(res.status, 'Could not start a session. Please reload the page.');
  const data = (await res.json()) as { token: string; user: UserProfile };
  if (data.token) localStorage.setItem(TOKEN_KEY, data.token);
  return data.token;
}

export async function getAuthToken(fresh = false): Promise<string> {
  if (!fresh) {
    const t = localStorage.getItem(TOKEN_KEY);
    if (t) return t;
  }
  sessionPromise ??= createAnonymousSession().finally(() => (sessionPromise = null));
  return sessionPromise;
}

async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem(TOKEN_KEY);
  const headers: Record<string, string> = {
    'X-Timezone': Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(init.headers as Record<string, string> ?? {}),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

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
  updateMe: (patch: Partial<Pick<UserProfile, 'displayName' | 'customInstructions' | 'memoryEnabled'>>) =>
    json<UserProfile>('/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }),

  // Auth
  signup: async (creds: { email: string; password: string; displayName?: string }) => {
    const res = await json<{ user: UserProfile; sessionToken: string }>('/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (res.sessionToken) localStorage.setItem(TOKEN_KEY, res.sessionToken);
    return res;
  },
  login: async (creds: { email: string; password: string }) => {
    const res = await json<{ user: UserProfile; sessionToken: string }>('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(creds),
    });
    if (res.sessionToken) localStorage.setItem(TOKEN_KEY, res.sessionToken);
    return res;
  },
  logout: async () => {
    await json<{ ok: boolean }>('/auth/logout', { method: 'POST' });
    localStorage.removeItem(TOKEN_KEY);
  },
  changePassword: (data: { currentPassword: string; newPassword: string }) =>
    json<{ ok: boolean; message: string }>('/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteAccount: async () => {
    await json<{ ok: boolean }>('/auth/delete-account', { method: 'POST' });
    localStorage.removeItem(TOKEN_KEY);
  },
  exportData: () => {
    window.location.href = '/api/me/export';
  },

  // Conversations
  listConversations: (q?: string) =>
    json<ConversationSummary[]>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  getConversation: (id: string) => json<ConversationDetail>(`/conversations/${id}`),
  renameConversation: (id: string, title: string) =>
    json<ConversationSummary>(`/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    }),
  deleteConversation: (id: string) => json<void>(`/conversations/${id}`, { method: 'DELETE' }),
  deleteAllConversations: () => json<{ deleted: number }>('/conversations', { method: 'DELETE' }),

  // Memories
  listMemories: () => json<{ memories: MemoryItem[]; enabled: boolean }>('/memories'),
  addMemory: (content: string) =>
    json<MemoryItem>('/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  updateMemory: (id: string, content: string) =>
    json<MemoryItem>(`/memories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    }),
  deleteMemory: (id: string) => json<void>(`/memories/${id}`, { method: 'DELETE' }),
  clearAllMemories: () => json<{ deleted: number }>('/memories', { method: 'DELETE' }),

  // File Upload
  uploadFiles: async (files: File[]): Promise<Attachment[]> => {
    const formData = new FormData();
    for (const file of files) {
      formData.append('files', file);
    }
    const token = localStorage.getItem(TOKEN_KEY);
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch('/api/upload', {
      method: 'POST',
      credentials: 'include',
      headers,
      body: formData,
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      throw new ApiError(res.status, (body as { error?: string }).error ?? 'Upload failed.');
    }
    const data = (await res.json()) as { attachments: Attachment[] };
    return data.attachments;
  },
};

/**
 * Start a streaming chat request. Resolves with an async iterator of events, or
 * throws ApiError (with a user-safe message) if the request was rejected.
 */
export async function* streamChat(req: ChatRequest, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  let res: Response;
  try {
    res = await authFetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'Network error. Check your connection and try again.');
  }

  if (res.status === 401) {
    // If anonymous token expired, get fresh anonymous token
    await getAuthToken(true);
    try {
      res = await authFetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
        signal,
      });
    } catch {
      if (signal.aborted) return;
      throw new ApiError(0, 'Network error. Check your connection and try again.');
    }
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
  } catch {
    if (signal.aborted) return;
    throw new ApiError(0, 'The connection was interrupted. Please try again.');
  }
}

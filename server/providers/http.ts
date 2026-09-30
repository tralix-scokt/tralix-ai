import { ProviderError } from './types.js';

/** fetch with a hard timeout that also honours a caller-provided abort signal. */
export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs: number; label: string; signal?: AbortSignal },
): Promise<T> {
  const { timeoutMs, label, signal, ...rest } = init;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('timeout')), timeoutMs);
  const onAbort = () => ctl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, { ...rest, signal: ctl.signal });
    if (!res.ok) {
      console.error(`[${label}] upstream ${res.status}`);
      if (res.status === 401 || res.status === 403)
        throw new ProviderError('auth', `${label} rejected the server's credentials.`, false);
      if (res.status === 429) throw new ProviderError('rate_limit', `${label} is rate limited right now.`, true);
      throw new ProviderError('unavailable', `${label} is unavailable right now.`, true);
    }
    return (await res.json()) as T;
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (signal?.aborted) throw new ProviderError('aborted', 'Cancelled.', false);
    if ((e as Error)?.name === 'AbortError' || (e as Error)?.name === 'TimeoutError' || ctl.signal.aborted)
      throw new ProviderError('timeout', `${label} took too long to respond.`, true);
    console.error(`[${label}] network error:`, (e as Error)?.message);
    throw new ProviderError('unavailable', `${label} could not be reached.`, true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function postJson<T>(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<T> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    timeoutMs,
    label: 'upstream',
    signal,
  });
}

export const isHttpUrl = (u: unknown): u is string => {
  if (typeof u !== 'string') return false;
  try {
    const p = new URL(u);
    return p.protocol === 'http:' || p.protocol === 'https:';
  } catch {
    return false;
  }
};

export const stripHtml = (s: string) =>
  s
    .replace(/<[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();

import type { Config } from '../../config.js';
import { fetchJson, isHttpUrl, stripHtml } from '../http.js';
import type { SearchProvider, SearchRequest, SearchResult } from '../types.js';

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const snippet = (s: string) => clip(s.replace(/\s+/g, ' ').trim(), 220);

/** Tavily — a search API built for LLM agents (https://tavily.com). */
export class TavilyProvider implements SearchProvider {
  readonly id = 'tavily';
  constructor(private key: string, private cfg: Config['search']) {}

  async search(req: SearchRequest): Promise<SearchResult[]> {
    const json = await fetchJson<{ results?: any[] }>('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        query: req.query,
        topic: req.topic ?? 'general',
        max_results: req.maxResults ?? this.cfg.maxResults,
        search_depth: 'basic',
        include_answer: false,
      }),
      timeoutMs: this.cfg.timeoutMs,
      label: 'Web search',
      signal: req.signal,
    });
    return (json.results ?? [])
      .filter((r) => isHttpUrl(r.url))
      .map((r) => ({
        title: String(r.title ?? r.url),
        url: r.url,
        snippet: snippet(String(r.content ?? '')),
        content: clip(String(r.content ?? ''), 1500),
        publishedAt: r.published_date,
      }));
  }
}

/** Brave Search API (https://brave.com/search/api). */
export class BraveProvider implements SearchProvider {
  readonly id = 'brave';
  constructor(private key: string, private cfg: Config['search']) {}

  async search(req: SearchRequest): Promise<SearchResult[]> {
    const news = req.topic === 'news';
    const u = new URL(`https://api.search.brave.com/res/v1/${news ? 'news' : 'web'}/search`);
    u.searchParams.set('q', req.query);
    u.searchParams.set('count', String(req.maxResults ?? this.cfg.maxResults));
    u.searchParams.set('extra_snippets', 'true');
    const json = await fetchJson<any>(u.toString(), {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.key },
      timeoutMs: this.cfg.timeoutMs,
      label: 'Web search',
      signal: req.signal,
    });
    const rows: any[] = (news ? json.results : json.web?.results) ?? [];
    return rows
      .filter((r) => isHttpUrl(r.url))
      .map((r) => {
        const body = stripHtml([r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(' '));
        return {
          title: stripHtml(String(r.title ?? r.url)),
          url: r.url,
          snippet: snippet(body),
          content: clip(body, 1500),
          publishedAt: r.age ?? r.page_age,
        };
      });
  }
}

/** SearXNG — self-hosted metasearch. Requires the JSON format to be enabled. */
export class SearxngProvider implements SearchProvider {
  readonly id = 'searxng';
  constructor(private baseUrl: string, private cfg: Config['search']) {}

  async search(req: SearchRequest): Promise<SearchResult[]> {
    const u = new URL(`${this.baseUrl}/search`);
    u.searchParams.set('q', req.query);
    u.searchParams.set('format', 'json');
    u.searchParams.set('categories', req.topic === 'news' ? 'news' : 'general');
    const json = await fetchJson<{ results?: any[] }>(u.toString(), {
      headers: { Accept: 'application/json' },
      timeoutMs: this.cfg.timeoutMs,
      label: 'Web search',
      signal: req.signal,
    });
    return (json.results ?? [])
      .filter((r) => isHttpUrl(r.url))
      .slice(0, req.maxResults ?? this.cfg.maxResults)
      .map((r) => {
        const body = stripHtml(String(r.content ?? ''));
        return {
          title: stripHtml(String(r.title ?? r.url)),
          url: r.url,
          snippet: snippet(body),
          content: clip(body, 1500),
          publishedAt: r.publishedDate ?? undefined,
        };
      });
  }
}

export function createSearchProvider(cfg: Config['search']): SearchProvider | undefined {
  switch (cfg.provider) {
    case 'tavily':
      return cfg.tavilyKey ? new TavilyProvider(cfg.tavilyKey, cfg) : undefined;
    case 'brave':
      return cfg.braveKey ? new BraveProvider(cfg.braveKey, cfg) : undefined;
    case 'searxng':
      return cfg.searxngUrl ? new SearxngProvider(cfg.searxngUrl, cfg) : undefined;
    default:
      return undefined;
  }
}

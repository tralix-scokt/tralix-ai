import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';
import { OpenAICompatibleProvider } from '../server/providers/text/openaiCompatible.js';
import type { Providers } from '../server/providers/registry.js';
import type { ImageGenerationProvider, SearchProvider, VisionProvider } from '../server/providers/types.js';
import { readSSE } from '../shared/sse.js';
import type { StreamEvent } from '../shared/types.js';

/** A protocol-level stand-in for an OpenAI-compatible server, used ONLY in tests. */
export interface MockLlm {
  url: string;
  requests: any[];
  handler: (body: any, res: http.ServerResponse) => void;
  close(): Promise<void>;
}

export const sseChunk = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`;
export const textChunk = (content: string, finish?: string) =>
  sseChunk({ choices: [{ delta: content ? { content } : {}, finish_reason: finish ?? null }] });

export async function startMockLlm(): Promise<MockLlm> {
  const mock: MockLlm = {
    url: '',
    requests: [],
    handler: (_b, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(textChunk('Hello'));
      res.write(textChunk(' there', 'stop'));
      res.end('data: [DONE]\n\n');
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      mock.requests.push({ url: req.url, headers: req.headers, body });
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '"Quick Greeting"' } }] }));
        return;
      }
      mock.handler(body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return mock;
}

export async function startApp(
  mock: MockLlm,
  overrides: {
    search?: SearchProvider;
    apiKey?: string;
    imageGeneration?: ImageGenerationProvider;
    vision?: VisionProvider;
  } = {},
) {
  const cfg = loadConfig();
  cfg.databaseUrl = undefined; // Force in-memory pg-mem database for tests
  cfg.llm = {
    ...cfg.llm,
    baseUrl: mock.url,
    apiKey: overrides.apiKey ?? 'sk-test-secret',
    model: 'test-model',
    titleModel: 'test-model',
  };
  cfg.limits.chatPerMinute = 1000;
  cfg.limits.authPerMinute = 1000;
  cfg.weatherEnabled = false;

  const providers: Providers = {
    text: new OpenAICompatibleProvider(cfg.llm),
    search: overrides.search,
    weatherEnabled: false,
    imageGeneration: overrides.imageGeneration,
    vision: overrides.vision,
  };

  const { app, pool, repo } = await createApp({ cfg, providers, webDir: '/nonexistent' });
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const session = async () => {
    const r = await fetch(`${base}/api/session`, { method: 'POST' });
    return ((await r.json()) as { token: string }).token;
  };

  const api = (token: string, path: string, init: RequestInit = {}) =>
    fetch(`${base}/api${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });

  const chat = async (token: string, body: unknown, signal?: AbortSignal) => {
    const res = await api(token, '/chat', { method: 'POST', body: JSON.stringify(body), signal });
    const events: StreamEvent[] = [];
    if (res.headers.get('content-type')?.includes('text/event-stream')) {
      for await (const m of readSSE(res.body!)) events.push(JSON.parse(m.data));
    }
    return { res, events };
  };

  return {
    base,
    pool,
    repo,
    session,
    api,
    chat,
    close: async () => {
      try {
        await pool.end();
      } catch {
        /* ignore */
      }
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

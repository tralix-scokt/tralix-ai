import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ChatRequest, StreamEvent } from '../shared/types.js';
import { newToken, requireUser } from './auth.js';
import { prepare, RequestError, run, type Deps } from './chat/orchestrator.js';
import { ToolRegistry } from './chat/tools.js';
import { loadConfig, type Config } from './config.js';
import { openDatabase, Repository } from './db.js';
import { createMemoryStore } from './memory/index.js';
import { createProviders, describeCapabilities, type Providers } from './providers/registry.js';
import { rateLimit } from './rateLimit.js';

export interface AppOptions {
  cfg?: Config;
  providers?: Providers;
  webDir?: string;
}

const conversationTitle = z.string().trim().min(1).max(100);
const chatSchema = z.object({
  conversationId: z.uuid().optional(),
  action: z.enum(['send', 'regenerate', 'edit', 'continue']),
  content: z.string().max(100_000).optional(),
  messageId: z.uuid().optional(),
});

export function createApp(opts: AppOptions = {}) {
  const cfg = opts.cfg ?? loadConfig();
  const db = openDatabase(cfg.databasePath);
  const repo = new Repository(db);
  const providers = opts.providers ?? createProviders(cfg);
  const deps: Deps = { cfg, repo, providers, memory: createMemoryStore(), tools: new ToolRegistry(providers, cfg) };

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  // Security headers. The app loads no third-party scripts, fonts or styles.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '256kb' }));
  api.use(rateLimit({ windowMs: 60_000, max: cfg.limits.apiPerMinute, key: (r) => r.ip ?? 'unknown' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  api.get('/capabilities', (_req, res) => void res.json(describeCapabilities(providers)));

  api.post(
    '/session',
    rateLimit({ windowMs: 60_000, max: 20, key: (r) => r.ip ?? 'unknown' }),
    (_req, res) => {
      const token = newToken();
      const user = repo.createUser(token);
      res.status(201).json({ token, user });
    },
  );

  api.use(requireUser(repo));

  api.get('/me', (req, res) => void res.json(req.user));
  api.patch('/me', (req, res) => {
    const body = z
      .object({ displayName: z.string().trim().max(60).optional(), customInstructions: z.string().max(2000).optional() })
      .safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Invalid profile values.' });
    res.json(repo.updateUser(req.user!.id, body.data));
  });

  api.get('/conversations', (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    res.json(repo.listConversations(req.user!.id, q));
  });
  api.post('/conversations', (req, res) => {
    if (repo.countConversations(req.user!.id) >= cfg.limits.maxConversationsPerUser)
      return void res.status(429).json({ error: 'Conversation limit reached. Delete some old chats first.' });
    res.status(201).json(repo.createConversation(req.user!.id));
  });
  api.delete('/conversations', (req, res) => void res.json({ deleted: repo.deleteAllConversations(req.user!.id) }));
  api.get('/conversations/:id', (req, res) => {
    const c = repo.getConversationDetail(req.user!.id, String(req.params.id));
    if (!c) return void res.status(404).json({ error: 'Conversation not found.' });
    res.json(c);
  });
  api.patch('/conversations/:id', (req, res) => {
    const body = z.object({ title: conversationTitle }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Title must be 1–100 characters.' });
    if (!repo.renameConversation(req.user!.id, String(req.params.id), body.data.title))
      return void res.status(404).json({ error: 'Conversation not found.' });
    res.json(repo.getConversation(req.user!.id, String(req.params.id)));
  });
  api.delete('/conversations/:id', (req, res) => {
    if (!repo.deleteConversation(req.user!.id, String(req.params.id)))
      return void res.status(404).json({ error: 'Conversation not found.' });
    res.status(204).end();
  });

  // ---- streaming chat ----
  const active = new Map<string, number>();
  api.post(
    '/chat',
    rateLimit({
      windowMs: 60_000,
      max: cfg.limits.chatPerMinute,
      key: (r) => `chat:${r.user?.id ?? r.ip}`,
      message: 'You are sending messages very quickly. Please wait a moment and try again.',
    }),
    async (req, res) => {
      const parsed = chatSchema.safeParse(req.body);
      if (!parsed.success) return void res.status(400).json({ error: 'Invalid request.' });
      const user = req.user!;
      if ((active.get(user.id) ?? 0) >= 3)
        return void res.status(429).json({ error: 'Too many responses are being generated at once. Please wait for one to finish.' });

      const tz = typeof req.headers['x-timezone'] === 'string' ? req.headers['x-timezone'].slice(0, 64) : undefined;
      let plan;
      try {
        plan = prepare(deps, user, parsed.data as ChatRequest, tz);
      } catch (e) {
        if (e instanceof RequestError) return void res.status(e.status).json({ error: e.message });
        throw e;
      }

      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const ctl = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) ctl.abort();
      });
      const emit = (e: StreamEvent) => {
        if (res.writableEnded || res.destroyed) return;
        res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      };
      const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15_000);

      active.set(user.id, (active.get(user.id) ?? 0) + 1);
      try {
        await run(deps, user, plan, emit, ctl.signal);
      } catch (e) {
        console.error('[chat] fatal:', (e as Error)?.message);
        emit({ type: 'error', code: 'unknown', message: 'Something went wrong. Please try again.', retryable: true });
      } finally {
        clearInterval(heartbeat);
        active.set(user.id, Math.max(0, (active.get(user.id) ?? 1) - 1));
        if (!res.writableEnded) res.end();
      }
    },
  );

  api.use((_req, res) => void res.status(404).json({ error: 'Not found.' }));
  app.use('/api', api);

  // ---- static web app ----
  const webDir = opts.webDir ?? path.resolve(process.cwd(), 'dist', 'web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(webDir, { maxAge: '1h', index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  // Never leak internals: log server-side, return a generic message.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request too large.' });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON.' });
    console.error('[server] error:', err?.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  });

  return { app, db, repo, deps };
}

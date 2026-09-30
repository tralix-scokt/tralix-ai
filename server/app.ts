import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { z } from 'zod';
import type { ChatRequest, StreamEvent } from '../shared/types.js';
import {
  clearSessionCookie,
  hashPassword,
  newToken,
  requireUser,
  resolveUser,
  setSessionCookie,
  verifyPassword,
} from './auth.js';
import { prepare, RequestError, run, type Deps } from './chat/orchestrator.js';
import { ToolRegistry } from './chat/tools.js';
import { loadConfig, type Config } from './config.js';
import { createDatabase, Repository } from './db.js';
import { createMemoryStore } from './memory/index.js';
import { createProviders, describeCapabilities, type Providers } from './providers/registry.js';
import { rateLimit } from './rateLimit.js';
import { createStorageService, type StorageService } from './storage/index.js';

export interface AppOptions {
  cfg?: Config;
  providers?: Providers;
  repo?: Repository;
  storage?: StorageService;
  webDir?: string;
}

const conversationTitle = z.string().trim().min(1).max(100);
const chatSchema = z.object({
  conversationId: z.string().uuid().optional(),
  action: z.enum(['send', 'regenerate', 'edit', 'continue']),
  content: z.string().max(100_000).optional(),
  messageId: z.string().uuid().optional(),
  attachmentIds: z.array(z.string().uuid()).optional(),
});

const signupSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  displayName: z.string().trim().max(60).optional(),
});

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'New password must be at least 8 characters').max(128),
});

const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
    files: 5,
  },
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_UPLOAD_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, GIF, MP4, WebM, MOV.`));
    }
  },
});

export async function createApp(opts: AppOptions = {}) {
  const cfg = opts.cfg ?? loadConfig();
  const pool = await createDatabase(cfg.databaseUrl);
  const repo = opts.repo ?? new Repository(pool);
  const providers = opts.providers ?? createProviders(cfg);
  const storage = opts.storage ?? createStorageService(cfg);
  const memory = createMemoryStore(repo);
  const tools = new ToolRegistry(providers, cfg, repo, storage);

  const deps: Deps = { cfg, repo, providers, memory, tools, storage };

  const app = express();
  app.disable('x-powered-by');
  if (cfg.trustProxy) app.set('trust proxy', 1);

  app.use(cookieParser(cfg.sessionSecret));

  // Security headers.
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self' https:; object-src 'none'; base-uri 'self'; form-action 'self'",
    );
    next();
  });

  app.get('/healthz', (_req, res) => void res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use(rateLimit({ windowMs: 60_000, max: cfg.limits.apiPerMinute, key: (r) => r.ip ?? 'unknown' }));
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  // Resolve user on all API requests (populates req.user if session exists)
  api.use(resolveUser(repo));

  api.get('/capabilities', (_req, res) => void res.json(describeCapabilities(providers)));

  // ---- Authentication & Accounts ----
  const authLimit = rateLimit({
    windowMs: 60_000,
    max: cfg.limits.authPerMinute,
    key: (r) => `auth:${r.ip ?? 'unknown'}`,
    message: 'Too many authentication attempts. Please wait a moment and try again.',
  });

  // Backward compatible anonymous session
  api.post('/session', authLimit, async (req, res) => {
    const token = newToken();
    const { user } = await repo.createAnonymousUser(token);
    const sessionToken = await repo.createSession(user.id);
    setSessionCookie(res, sessionToken, cfg.nodeEnv === 'production');
    res.status(201).json({ token: sessionToken, legacyToken: token, user });
  });

  api.post('/auth/signup', authLimit, async (req, res) => {
    const parsed = signupSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid signup details.' });
    }

    const { email, password, displayName } = parsed.data;
    const existing = await repo.getUserByEmail(email);
    if (existing) {
      return void res.status(409).json({ error: 'An account with that email already exists.' });
    }

    const passwordHash = await hashPassword(password);
    const previousAnonymousUser = req.user?.isAnonymous ? req.user : null;

    const user = await repo.createUser({
      email,
      passwordHash,
      displayName: displayName || email.split('@')[0],
    });

    // Migrate any data from previous anonymous device session
    if (previousAnonymousUser && previousAnonymousUser.id !== user.id) {
      await repo.linkAnonymousData(previousAnonymousUser.id, user.id);
    }

    const sessionToken = await repo.createSession(user.id);
    setSessionCookie(res, sessionToken, cfg.nodeEnv === 'production');
    res.status(201).json({ user, sessionToken });
  });

  api.post('/auth/login', authLimit, async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: 'Please enter a valid email and password.' });
    }

    const { email, password } = parsed.data;
    const userWithHash = await repo.getUserByEmail(email);
    if (!userWithHash || !userWithHash.passwordHash) {
      return void res.status(401).json({ error: 'Invalid email or password.' });
    }

    const valid = await verifyPassword(password, userWithHash.passwordHash);
    if (!valid) {
      return void res.status(401).json({ error: 'Invalid email or password.' });
    }

    const previousAnonymousUser = req.user?.isAnonymous ? req.user : null;
    const { passwordHash: _, ...user } = userWithHash;

    if (previousAnonymousUser && previousAnonymousUser.id !== user.id) {
      await repo.linkAnonymousData(previousAnonymousUser.id, user.id);
    }

    const sessionToken = await repo.createSession(user.id);
    setSessionCookie(res, sessionToken, cfg.nodeEnv === 'production');
    res.json({ user, sessionToken });
  });

  api.post('/auth/logout', async (req, res) => {
    if (req.sessionToken) {
      await repo.deleteSession(req.sessionToken);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  api.post('/auth/anonymous', authLimit, async (_req, res) => {
    const token = newToken();
    const { user } = await repo.createAnonymousUser(token);
    const sessionToken = await repo.createSession(user.id);
    setSessionCookie(res, sessionToken, cfg.nodeEnv === 'production');
    res.status(201).json({ token: sessionToken, user });
  });

  // Optional: Google Sign-in verify
  api.post('/auth/google', authLimit, async (req, res) => {
    const credential = req.body?.credential;
    if (!credential || typeof credential !== 'string') {
      return void res.status(400).json({ error: 'Missing Google credential.' });
    }

    try {
      const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
      if (!verifyRes.ok) {
        return void res.status(401).json({ error: 'Google authentication failed.' });
      }
      const data = (await verifyRes.json()) as { email?: string; name?: string; aud?: string };
      if (!data.email) {
        return void res.status(401).json({ error: 'Google account missing email.' });
      }

      let user = await repo.getUserByEmail(data.email);
      if (!user) {
        user = await repo.createUser({
          email: data.email,
          displayName: data.name || data.email.split('@')[0],
        });
      }

      const previousAnonymousUser = req.user?.isAnonymous ? req.user : null;
      if (previousAnonymousUser && previousAnonymousUser.id !== user.id) {
        await repo.linkAnonymousData(previousAnonymousUser.id, user.id);
      }

      const sessionToken = await repo.createSession(user.id);
      setSessionCookie(res, sessionToken, cfg.nodeEnv === 'production');
      res.json({ user, sessionToken });
    } catch {
      res.status(500).json({ error: 'Could not verify Google login.' });
    }
  });

  // Protected routes below
  api.use(requireUser());

  api.get('/me', (req, res) => void res.json(req.user));
  api.patch('/me', async (req, res) => {
    const body = z
      .object({
        displayName: z.string().trim().max(60).optional(),
        customInstructions: z.string().max(2000).optional(),
        memoryEnabled: z.boolean().optional(),
      })
      .safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Invalid profile values.' });
    const updated = await repo.updateUser(req.user!.id, body.data);
    res.json(updated);
  });

  api.post('/auth/change-password', async (req, res) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return void res.status(400).json({ error: parsed.error.issues[0]?.message || 'Invalid password.' });
    }

    const { currentPassword, newPassword } = parsed.data;
    const userWithHash = await repo.getUserByEmail(req.user!.email || '');
    if (!userWithHash || !userWithHash.passwordHash) {
      return void res.status(400).json({ error: 'This account does not have a password set.' });
    }

    const valid = await verifyPassword(currentPassword, userWithHash.passwordHash);
    if (!valid) {
      return void res.status(401).json({ error: 'Current password is incorrect.' });
    }

    const newHash = await hashPassword(newPassword);
    await repo.updateUserPassword(req.user!.id, newHash);
    res.json({ ok: true, message: 'Password updated successfully.' });
  });

  api.post('/auth/delete-account', async (req, res) => {
    await repo.deleteUser(req.user!.id);
    clearSessionCookie(res);
    res.json({ ok: true, message: 'Account and all data deleted permanently.' });
  });

  api.get('/me/export', async (req, res) => {
    const exported = await repo.exportUserData(req.user!.id);
    if (!exported) return void res.status(404).json({ error: 'User data not found.' });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="tralix-data-${req.user!.id}.json"`);
    res.json(exported);
  });

  // ---- Long-term Memory routes ----
  api.get('/memories', async (req, res) => {
    const memories = await repo.listMemories(req.user!.id);
    res.json({ memories, enabled: req.user!.memoryEnabled });
  });

  api.post('/memories', async (req, res) => {
    const content = z.string().trim().min(1).max(1000).safeParse(req.body?.content);
    if (!content.success) return void res.status(400).json({ error: 'Memory content must be 1–1000 characters.' });
    const memory = await repo.addMemory(req.user!.id, content.data);
    res.status(201).json(memory);
  });

  api.patch('/memories/:id', async (req, res) => {
    const content = z.string().trim().min(1).max(1000).safeParse(req.body?.content);
    if (!content.success) return void res.status(400).json({ error: 'Memory content must be 1–1000 characters.' });
    const updated = await repo.updateMemory(req.user!.id, String(req.params.id), content.data);
    if (!updated) return void res.status(404).json({ error: 'Memory not found.' });
    res.json(updated);
  });

  api.delete('/memories/:id', async (req, res) => {
    const ok = await repo.deleteMemory(req.user!.id, String(req.params.id));
    if (!ok) return void res.status(404).json({ error: 'Memory not found.' });
    res.status(204).end();
  });

  api.delete('/memories', async (req, res) => {
    const count = await repo.deleteAllMemories(req.user!.id);
    res.json({ deleted: count });
  });

  // ---- File Uploads & Attachments ----
  api.post('/upload', upload.array('files', 5), async (req, res) => {
    const files = req.files as Express.Multer.File[] | undefined;
    if (!files || !files.length) {
      return void res.status(400).json({ error: 'No files uploaded.' });
    }

    const savedAttachments = [];
    for (const file of files) {
      const isVideo = file.mimetype.startsWith('video/');
      const maxSize = isVideo ? 50 * 1024 * 1024 : 20 * 1024 * 1024;
      if (file.size > maxSize) {
        return void res.status(413).json({
          error: `File "${file.originalname}" is too large (max ${isVideo ? '50MB' : '20MB'}).`,
        });
      }

      const attId = crypto.randomUUID();
      const ext = path.extname(file.originalname) || (isVideo ? '.mp4' : '.jpg');
      const storageKey = `users/${req.user!.id}/attachments/${attId}${ext}`;

      const { storageType } = await storage.putObject(storageKey, file.buffer, file.mimetype);
      const att = await repo.addAttachment(req.user!.id, {
        id: attId,
        filename: file.originalname,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        storageKey,
        storageType,
      });

      savedAttachments.push(att);
    }

    res.status(201).json({ attachments: savedAttachments });
  });

  api.get('/attachments/:id', async (req, res) => {
    const att = await repo.getAttachment(req.user!.id, String(req.params.id));
    if (!att) return void res.status(404).json({ error: 'Attachment not found.' });

    if (att.storageType === 's3') {
      const signed = await storage.getSignedDownloadUrl(att.storageKey, 3600);
      if (signed) return void res.redirect(302, signed);
    }

    const file = await storage.getObject(att.storageKey);
    if (!file) return void res.status(404).json({ error: 'File content not found.' });

    res.setHeader('Content-Type', att.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(att.filename)}"`);
    res.send(file.buffer);
  });

  // ---- Generated Images ----
  api.get('/images/:id', async (req, res) => {
    const img = await repo.getGeneratedImage(req.user!.id, String(req.params.id));
    if (!img) return void res.status(404).json({ error: 'Image not found.' });

    if (img.storageType === 's3') {
      const signed = await storage.getSignedDownloadUrl(img.storageKey, 3600);
      if (signed) return void res.redirect(302, signed);
    }

    const file = await storage.getObject(img.storageKey);
    if (!file) return void res.status(404).json({ error: 'Image content not found.' });

    res.setHeader('Content-Type', img.mimeType);
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename="tralix-image-${img.id}.png"`);
    } else {
      res.setHeader('Content-Disposition', 'inline');
    }
    res.send(file.buffer);
  });

  // ---- Conversations ----
  api.get('/conversations', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : undefined;
    const convs = await repo.listConversations(req.user!.id, q);
    res.json(convs);
  });

  api.post('/conversations', async (req, res) => {
    const count = await repo.countConversations(req.user!.id);
    if (count >= cfg.limits.maxConversationsPerUser) {
      return void res.status(429).json({ error: 'Conversation limit reached. Delete some old chats first.' });
    }
    const conv = await repo.createConversation(req.user!.id);
    res.status(201).json(conv);
  });

  api.delete('/conversations', async (req, res) => {
    const deleted = await repo.deleteAllConversations(req.user!.id);
    res.json({ deleted });
  });

  api.get('/conversations/:id', async (req, res) => {
    const c = await repo.getConversationDetail(req.user!.id, String(req.params.id));
    if (!c) return void res.status(404).json({ error: 'Conversation not found.' });
    res.json(c);
  });

  api.patch('/conversations/:id', async (req, res) => {
    const body = z.object({ title: conversationTitle }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'Title must be 1–100 characters.' });
    const ok = await repo.renameConversation(req.user!.id, String(req.params.id), body.data.title);
    if (!ok) return void res.status(404).json({ error: 'Conversation not found.' });
    res.json(await repo.getConversation(req.user!.id, String(req.params.id)));
  });

  api.delete('/conversations/:id', async (req, res) => {
    const ok = await repo.deleteConversation(req.user!.id, String(req.params.id));
    if (!ok) return void res.status(404).json({ error: 'Conversation not found.' });
    res.status(204).end();
  });

  // ---- Streaming Chat ----
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
      if ((active.get(user.id) ?? 0) >= 3) {
        return void res.status(429).json({
          error: 'Too many responses are being generated at once. Please wait for one to finish.',
        });
      }

      const tz = typeof req.headers['x-timezone'] === 'string' ? req.headers['x-timezone'].slice(0, 64) : undefined;
      let plan;
      try {
        plan = await prepare(deps, user, parsed.data as ChatRequest, tz);
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

  // ---- Static Web App ----
  const webDir = opts.webDir ?? path.resolve(process.cwd(), 'dist', 'web');
  if (fs.existsSync(path.join(webDir, 'index.html'))) {
    app.use('/assets', express.static(path.join(webDir, 'assets'), { immutable: true, maxAge: '1y' }));
    app.use(express.static(webDir, { maxAge: '1h', index: false }));
    app.get(/^(?!\/api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(webDir, 'index.html'));
    });
  }

  // Error handling middleware
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return void res.status(413).json({ error: 'File is too large. Max 20MB for images, 50MB for videos.' });
    }
    if (err?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request too large.' });
    if (err?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Invalid JSON.' });
    console.error('[server] error:', err?.message);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error.' });
  });

  return { app, pool, repo, deps };
}

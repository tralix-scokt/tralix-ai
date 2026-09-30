import crypto from 'node:crypto';
import pg from 'pg';
import type {
  Attachment,
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  MemoryItem,
  MessageStatus,
  Role,
  Source,
  UserProfile,
} from '../shared/types.js';
import { runMigrations } from './db/migrations.js';

const { Pool, types } = pg;

// Parse PostgreSQL BIGINT (type 20) as JavaScript number
types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));

export type DB = pg.Pool;

export const id = () => crypto.randomUUID();
export const now = () => Date.now();
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

interface UserRow {
  id: string;
  email: string | null;
  password_hash: string | null;
  token_hash: string | null;
  display_name: string;
  custom_instructions: string;
  memory_enabled: boolean;
  created_at: number | string;
  updated_at: number | string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: Role;
  content: string;
  status: MessageStatus;
  sources: string;
  attachments: string;
  created_at: number | string;
}

interface ConvRow {
  id: string;
  user_id: string;
  title: string;
  title_locked: number;
  created_at: number | string;
  updated_at: number | string;
}

interface MemoryRow {
  id: string;
  user_id: string;
  content: string;
  created_at: number | string;
  updated_at: number | string;
}

interface AttachmentRow {
  id: string;
  user_id: string;
  conversation_id: string | null;
  message_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number | string;
  storage_key: string;
  storage_type: string;
  metadata: string;
  created_at: number | string;
}

function toUserProfile(r: UserRow): UserProfile {
  return {
    id: r.id,
    email: r.email ?? undefined,
    displayName: r.display_name ?? '',
    customInstructions: r.custom_instructions ?? '',
    memoryEnabled: r.memory_enabled !== false,
    isAnonymous: !r.email,
  };
}

function toMessage(r: MessageRow): ChatMessage {
  let sources: Source[] = [];
  try {
    sources = JSON.parse(r.sources) as Source[];
  } catch {
    sources = [];
  }
  let attachments: Attachment[] = [];
  try {
    attachments = JSON.parse(r.attachments) as Attachment[];
  } catch {
    attachments = [];
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    status: r.status,
    sources,
    attachments,
    createdAt: Number(r.created_at),
  };
}

const toSummary = (r: ConvRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

const toMemory = (r: MemoryRow): MemoryItem => ({
  id: r.id,
  content: r.content,
  createdAt: Number(r.created_at),
  updatedAt: Number(r.updated_at),
});

/** Escape LIKE/ILIKE wildcards so user search text is matched literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function createDatabase(databaseUrl?: string): Promise<pg.Pool> {
  if (databaseUrl && databaseUrl.trim()) {
    const isRemote = !databaseUrl.includes('localhost') && !databaseUrl.includes('127.0.0.1');
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: isRemote ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
    await runMigrations(pool);
    return pool;
  }

  // In-memory postgres emulation for tests or zero-config local run
  const { newDb } = await import('pg-mem');
  const mem = newDb();
  const pgMemAdapter = mem.adapters.createPg();
  const pool = new pgMemAdapter.Pool() as unknown as pg.Pool;
  await runMigrations(pool);
  return pool;
}

export class Repository {
  private pool: pg.Pool;
  constructor(pool: pg.Pool) {
    this.pool = pool;
  }

  // ---- users ----
  async createUser(opts: {
    email?: string;
    passwordHash?: string;
    displayName?: string;
    tokenHash?: string;
  }): Promise<UserProfile> {
    const uid = id();
    const t = now();
    const email = opts.email ? opts.email.toLowerCase().trim() : null;
    const { rows } = await this.pool.query<UserRow>(
      `INSERT INTO users (id, email, password_hash, token_hash, display_name, custom_instructions, memory_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [uid, email, opts.passwordHash ?? null, opts.tokenHash ?? null, opts.displayName ?? '', '', true, t, t],
    );
    return toUserProfile(rows[0]);
  }

  async createAnonymousUser(token: string): Promise<{ user: UserProfile; token: string }> {
    const user = await this.createUser({ tokenHash: hashToken(token) });
    return { user, token };
  }

  async getUserById(userId: string): Promise<UserProfile | null> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [userId]);
    return rows.length ? toUserProfile(rows[0]) : null;
  }

  async getUserByEmail(email: string): Promise<(UserProfile & { passwordHash?: string }) | null> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase().trim()]);
    if (!rows.length) return null;
    const u = toUserProfile(rows[0]);
    return { ...u, passwordHash: rows[0].password_hash ?? undefined };
  }

  async getUserByToken(token: string): Promise<UserProfile | null> {
    const hashed = hashToken(token);
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE token_hash = $1', [hashed]);
    return rows.length ? toUserProfile(rows[0]) : null;
  }

  async getUserBySession(sessionId: string): Promise<UserProfile | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT u.* FROM users u
       JOIN sessions s ON s.user_id = u.id
       WHERE s.id = $1 AND s.expires_at > $2`,
      [sessionId, now()],
    );
    return rows.length ? toUserProfile(rows[0]) : null;
  }

  async updateUser(
    userId: string,
    patch: Partial<Pick<UserProfile, 'displayName' | 'customInstructions' | 'memoryEnabled'>>,
  ): Promise<UserProfile> {
    const cur = await this.getUserById(userId);
    if (!cur) throw new Error('User not found');

    const nextName = patch.displayName !== undefined ? patch.displayName : cur.displayName;
    const nextInst = patch.customInstructions !== undefined ? patch.customInstructions : cur.customInstructions;
    const nextMem = patch.memoryEnabled !== undefined ? patch.memoryEnabled : cur.memoryEnabled;

    const { rows } = await this.pool.query<UserRow>(
      `UPDATE users
       SET display_name = $1, custom_instructions = $2, memory_enabled = $3, updated_at = $4
       WHERE id = $5
       RETURNING *`,
      [nextName, nextInst, nextMem, now(), userId],
    );
    return toUserProfile(rows[0]);
  }

  async updateUserPassword(userId: string, passwordHash: string): Promise<void> {
    await this.pool.query('UPDATE users SET password_hash = $1, updated_at = $2 WHERE id = $3', [passwordHash, now(), userId]);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM users WHERE id = $1', [userId]);
  }

  async linkAnonymousData(anonymousUserId: string, targetUserId: string): Promise<void> {
    if (anonymousUserId === targetUserId) return;
    await this.pool.query('UPDATE conversations SET user_id = $1 WHERE user_id = $2', [targetUserId, anonymousUserId]);
    await this.pool.query('UPDATE memories SET user_id = $1 WHERE user_id = $2', [targetUserId, anonymousUserId]);
    await this.pool.query('UPDATE attachments SET user_id = $1 WHERE user_id = $2', [targetUserId, anonymousUserId]);
    await this.pool.query('UPDATE generated_images SET user_id = $1 WHERE user_id = $2', [targetUserId, anonymousUserId]);
    await this.pool.query('DELETE FROM users WHERE id = $1', [anonymousUserId]);
  }

  // ---- sessions ----
  async createSession(userId: string, ttlMs = 30 * 24 * 60 * 60 * 1000): Promise<string> {
    const sid = crypto.randomBytes(32).toString('base64url');
    const t = now();
    await this.pool.query(
      'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
      [sid, userId, t, t + ttlMs],
    );
    return sid;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1', [userId]);
  }

  // ---- conversations ----
  async countConversations(userId: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string | number }>(
      'SELECT COUNT(*) as count FROM conversations WHERE user_id = $1',
      [userId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async createConversation(userId: string, title = 'New chat'): Promise<ConversationSummary> {
    const t = now();
    const cid = id();
    const { rows } = await this.pool.query<ConvRow>(
      `INSERT INTO conversations (id, user_id, title, title_locked, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [cid, userId, title, 0, t, t],
    );
    return toSummary(rows[0]);
  }

  async listConversations(userId: string, query?: string, limit = 200): Promise<ConversationSummary[]> {
    const q = query?.trim();
    if (!q) {
      const { rows } = await this.pool.query<ConvRow>(
        `SELECT id, user_id, title, title_locked, created_at, updated_at
         FROM conversations
         WHERE user_id = $1
         ORDER BY updated_at DESC
         LIMIT $2`,
        [userId, limit],
      );
      return rows.map(toSummary);
    }

    const like = `%${likeEscape(q.slice(0, 100))}%`;
    const { rows } = await this.pool.query<ConvRow>(
      `SELECT id, user_id, title, title_locked, created_at, updated_at
       FROM conversations
       WHERE user_id = $1 AND (
         title ILIKE $2 OR
         id IN (SELECT conversation_id FROM messages WHERE content ILIKE $2)
       )
       ORDER BY updated_at DESC
       LIMIT $3`,
      [userId, like, limit],
    );
    return rows.map(toSummary);
  }

  async getConversation(userId: string, convId: string): Promise<(ConversationSummary & { titleLocked: boolean }) | null> {
    const { rows } = await this.pool.query<ConvRow>(
      'SELECT * FROM conversations WHERE id = $1 AND user_id = $2',
      [convId, userId],
    );
    return rows.length ? { ...toSummary(rows[0]), titleLocked: !!rows[0].title_locked } : null;
  }

  async getConversationDetail(userId: string, convId: string): Promise<ConversationDetail | null> {
    const c = await this.getConversation(userId, convId);
    if (!c) return null;
    const messages = await this.listMessages(convId);
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messages };
  }

  async renameConversation(userId: string, convId: string, title: string): Promise<boolean> {
    const res = await this.pool.query(
      'UPDATE conversations SET title = $1, title_locked = 1, updated_at = $2 WHERE id = $3 AND user_id = $4',
      [title, now(), convId, userId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setGeneratedTitle(convId: string, title: string): Promise<boolean> {
    const res = await this.pool.query(
      'UPDATE conversations SET title = $1 WHERE id = $2 AND title_locked = 0',
      [title, convId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async touchConversation(convId: string): Promise<void> {
    await this.pool.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [now(), convId]);
  }

  async deleteConversation(userId: string, convId: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM conversations WHERE id = $1 AND user_id = $2', [convId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteAllConversations(userId: string): Promise<number> {
    const res = await this.pool.query('DELETE FROM conversations WHERE user_id = $1', [userId]);
    return res.rowCount ?? 0;
  }

  // ---- messages ----
  async listMessages(convId: string): Promise<ChatMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      'SELECT * FROM messages WHERE conversation_id = $1 ORDER BY seq ASC',
      [convId],
    );
    return rows.map(toMessage);
  }

  async getMessage(convId: string, messageId: string): Promise<ChatMessage | null> {
    const { rows } = await this.pool.query<MessageRow>(
      'SELECT * FROM messages WHERE id = $1 AND conversation_id = $2',
      [messageId, convId],
    );
    return rows.length ? toMessage(rows[0]) : null;
  }

  async addMessage(
    convId: string,
    m: {
      role: Role;
      content: string;
      status?: MessageStatus;
      sources?: Source[];
      attachments?: Attachment[];
      id?: string;
    },
  ): Promise<ChatMessage> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const seqRes = await client.query<{ s: number | null }>(
        'SELECT MAX(seq) as s FROM messages WHERE conversation_id = $1',
        [convId],
      );
      const seq = (Number(seqRes.rows[0]?.s) || 0) + 1;
      const mid = m.id ?? id();
      const t = now();
      const { rows } = await client.query<MessageRow>(
        `INSERT INTO messages (id, conversation_id, seq, role, content, status, sources, attachments, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          mid,
          convId,
          seq,
          m.role,
          m.content,
          m.status ?? 'complete',
          JSON.stringify(m.sources ?? []),
          JSON.stringify(m.attachments ?? []),
          t,
        ],
      );
      await client.query('UPDATE conversations SET updated_at = $1 WHERE id = $2', [t, convId]);
      await client.query('COMMIT');
      return toMessage(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateMessage(
    messageId: string,
    patch: { content?: string; status?: MessageStatus; sources?: Source[]; attachments?: Attachment[] },
  ): Promise<void> {
    const { rows } = await this.pool.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [messageId]);
    if (!rows.length) return;
    const cur = rows[0];
    const content = patch.content !== undefined ? patch.content : cur.content;
    const status = patch.status !== undefined ? patch.status : cur.status;
    const sources = patch.sources !== undefined ? JSON.stringify(patch.sources) : cur.sources;
    const attachments = patch.attachments !== undefined ? JSON.stringify(patch.attachments) : cur.attachments;

    await this.pool.query(
      'UPDATE messages SET content = $1, status = $2, sources = $3, attachments = $4 WHERE id = $5',
      [content, status, sources, attachments, messageId],
    );
  }

  async truncateAfter(convId: string, messageId: string, inclusive = false): Promise<void> {
    const { rows } = await this.pool.query<{ seq: number }>(
      'SELECT seq FROM messages WHERE id = $1 AND conversation_id = $2',
      [messageId, convId],
    );
    if (!rows.length) return;
    const op = inclusive ? '>=' : '>';
    await this.pool.query(`DELETE FROM messages WHERE conversation_id = $1 AND seq ${op} $2`, [convId, rows[0].seq]);
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.pool.query('DELETE FROM messages WHERE id = $1', [messageId]);
  }

  // ---- attachments ----
  async addAttachment(
    userId: string,
    a: {
      id?: string;
      conversationId?: string;
      messageId?: string;
      filename: string;
      mimeType: string;
      sizeBytes: number;
      storageKey: string;
      storageType?: string;
      metadata?: any;
    },
  ): Promise<Attachment & { storageKey: string; storageType: string }> {
    const aid = a.id ?? id();
    const t = now();
    const { rows } = await this.pool.query<AttachmentRow>(
      `INSERT INTO attachments (id, user_id, conversation_id, message_id, filename, mime_type, size_bytes, storage_key, storage_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        aid,
        userId,
        a.conversationId ?? null,
        a.messageId ?? null,
        a.filename,
        a.mimeType,
        a.sizeBytes,
        a.storageKey,
        a.storageType ?? 'local',
        JSON.stringify(a.metadata ?? {}),
        t,
      ],
    );
    const r = rows[0];
    return {
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      url: `/api/attachments/${r.id}`,
      storageKey: r.storage_key,
      storageType: r.storage_type,
    };
  }

  async getAttachment(userId: string, id: string): Promise<(Attachment & { storageKey: string; storageType: string }) | null> {
    const { rows } = await this.pool.query<AttachmentRow>(
      'SELECT * FROM attachments WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      url: `/api/attachments/${r.id}`,
      storageKey: r.storage_key,
      storageType: r.storage_type,
    };
  }

  async getAttachmentsByIds(userId: string, ids: string[]): Promise<(Attachment & { storageKey: string; storageType: string })[]> {
    if (!ids.length) return [];
    const { rows } = await this.pool.query<AttachmentRow>(
      `SELECT * FROM attachments WHERE user_id = $1 AND id = ANY($2::text[])`,
      [userId, ids],
    );
    return rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      mimeType: r.mime_type,
      sizeBytes: Number(r.size_bytes),
      url: `/api/attachments/${r.id}`,
      storageKey: r.storage_key,
      storageType: r.storage_type,
    }));
  }

  async linkAttachmentsToMessage(
    userId: string,
    messageId: string,
    conversationId: string,
    attachmentIds: string[],
  ): Promise<void> {
    if (!attachmentIds.length) return;
    await this.pool.query(
      `UPDATE attachments
       SET message_id = $1, conversation_id = $2
       WHERE user_id = $3 AND id = ANY($4::text[])`,
      [messageId, conversationId, userId, attachmentIds],
    );
  }

  // ---- memories ----
  async listMemories(userId: string): Promise<MemoryItem[]> {
    const { rows } = await this.pool.query<MemoryRow>(
      'SELECT * FROM memories WHERE user_id = $1 ORDER BY updated_at DESC',
      [userId],
    );
    return rows.map(toMemory);
  }

  async getMemory(userId: string, id: string): Promise<MemoryItem | null> {
    const { rows } = await this.pool.query<MemoryRow>(
      'SELECT * FROM memories WHERE id = $1 AND user_id = $2',
      [id, userId],
    );
    return rows.length ? toMemory(rows[0]) : null;
  }

  async addMemory(userId: string, content: string): Promise<MemoryItem> {
    const mid = id();
    const t = now();
    const { rows } = await this.pool.query<MemoryRow>(
      `INSERT INTO memories (id, user_id, content, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [mid, userId, content.trim(), t, t],
    );
    return toMemory(rows[0]);
  }

  async updateMemory(userId: string, memoryId: string, content: string): Promise<MemoryItem | null> {
    const { rows } = await this.pool.query<MemoryRow>(
      `UPDATE memories
       SET content = $1, updated_at = $2
       WHERE id = $3 AND user_id = $4
       RETURNING *`,
      [content.trim(), now(), memoryId, userId],
    );
    return rows.length ? toMemory(rows[0]) : null;
  }

  async deleteMemory(userId: string, memoryId: string): Promise<boolean> {
    const res = await this.pool.query('DELETE FROM memories WHERE id = $1 AND user_id = $2', [memoryId, userId]);
    return (res.rowCount ?? 0) > 0;
  }

  async deleteAllMemories(userId: string): Promise<number> {
    const res = await this.pool.query('DELETE FROM memories WHERE user_id = $1', [userId]);
    return res.rowCount ?? 0;
  }

  // ---- generated images ----
  async recordGeneratedImage(
    userId: string,
    img: {
      id?: string;
      prompt: string;
      revisedPrompt?: string;
      storageKey: string;
      storageType?: string;
      mimeType?: string;
    },
  ): Promise<string> {
    const iid = img.id ?? id();
    await this.pool.query(
      `INSERT INTO generated_images (id, user_id, prompt, revised_prompt, storage_key, storage_type, mime_type, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [iid, userId, img.prompt, img.revisedPrompt ?? null, img.storageKey, img.storageType ?? 'local', img.mimeType ?? 'image/png', now()],
    );
    return iid;
  }

  async getGeneratedImage(
    userId: string,
    id: string,
  ): Promise<{ id: string; userId: string; prompt: string; storageKey: string; storageType: string; mimeType: string } | null> {
    const { rows } = await this.pool.query<{
      id: string;
      user_id: string;
      prompt: string;
      storage_key: string;
      storage_type: string;
      mime_type: string;
    }>('SELECT * FROM generated_images WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!rows.length) return null;
    const r = rows[0];
    return {
      id: r.id,
      userId: r.user_id,
      prompt: r.prompt,
      storageKey: r.storage_key,
      storageType: r.storage_type,
      mimeType: r.mime_type,
    };
  }

  async countGeneratedImagesSince(userId: string, since: number): Promise<number> {
    const { rows } = await this.pool.query<{ count: string | number }>(
      'SELECT COUNT(*) as count FROM generated_images WHERE user_id = $1 AND created_at >= $2',
      [userId, since],
    );
    return Number(rows[0]?.count ?? 0);
  }

  // ---- data export ----
  async exportUserData(userId: string) {
    const user = await this.getUserById(userId);
    if (!user) return null;
    const conversations = await this.listConversations(userId, undefined, 1000);
    const convDetails: ConversationDetail[] = [];
    for (const c of conversations) {
      const d = await this.getConversationDetail(userId, c.id);
      if (d) convDetails.push(d);
    }
    const memories = await this.listMemories(userId);
    return {
      user,
      conversations: convDetails,
      memories,
      exportedAt: new Date().toISOString(),
    };
  }
}

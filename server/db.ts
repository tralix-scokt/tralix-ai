import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  ChatMessage,
  ConversationDetail,
  ConversationSummary,
  MessageStatus,
  Role,
  Source,
  UserProfile,
} from '../shared/types.js';

export type DB = Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  custom_instructions TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  title_locked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'complete',
  sources TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);
-- Reserved for the opt-in persistent-memory feature (not active in V1).
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
`;

export function openDatabase(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

const id = () => crypto.randomUUID();
const now = () => Date.now();
export const hashToken = (t: string) => crypto.createHash('sha256').update(t).digest('hex');

interface MessageRow {
  id: string;
  conversation_id: string;
  role: Role;
  content: string;
  status: MessageStatus;
  sources: string;
  created_at: number;
}
interface ConvRow {
  id: string;
  title: string;
  title_locked: number;
  created_at: number;
  updated_at: number;
}

function toMessage(r: MessageRow): ChatMessage {
  let sources: Source[] = [];
  try {
    sources = JSON.parse(r.sources) as Source[];
  } catch {
    /* corrupted JSON → no sources */
  }
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    status: r.status,
    sources,
    createdAt: r.created_at,
  };
}
const toSummary = (r: ConvRow): ConversationSummary => ({
  id: r.id,
  title: r.title,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** Escape LIKE wildcards so user search text is matched literally. */
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class Repository {
  constructor(private db: DB) {}

  // ---- users ----
  createUser(token: string): UserProfile {
    const user: UserProfile = { id: id(), displayName: '', customInstructions: '' };
    this.db
      .prepare('INSERT INTO users (id, token_hash, created_at) VALUES (?, ?, ?)')
      .run(user.id, hashToken(token), now());
    return user;
  }
  getUserByToken(token: string): UserProfile | null {
    const r = this.db
      .prepare('SELECT id, display_name, custom_instructions FROM users WHERE token_hash = ?')
      .get(hashToken(token)) as { id: string; display_name: string; custom_instructions: string } | undefined;
    return r ? { id: r.id, displayName: r.display_name, customInstructions: r.custom_instructions } : null;
  }
  updateUser(userId: string, patch: Partial<Pick<UserProfile, 'displayName' | 'customInstructions'>>): UserProfile {
    if (patch.displayName !== undefined)
      this.db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(patch.displayName, userId);
    if (patch.customInstructions !== undefined)
      this.db.prepare('UPDATE users SET custom_instructions = ? WHERE id = ?').run(patch.customInstructions, userId);
    const r = this.db
      .prepare('SELECT id, display_name, custom_instructions FROM users WHERE id = ?')
      .get(userId) as { id: string; display_name: string; custom_instructions: string };
    return { id: r.id, displayName: r.display_name, customInstructions: r.custom_instructions };
  }

  // ---- conversations ----
  countConversations(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM conversations WHERE user_id = ?').get(userId) as { c: number }).c;
  }
  createConversation(userId: string, title = 'New chat'): ConversationSummary {
    const t = now();
    const c: ConvRow = { id: id(), title, title_locked: 0, created_at: t, updated_at: t };
    this.db
      .prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?,?,?,?,?)')
      .run(c.id, userId, title, t, t);
    return toSummary(c);
  }
  listConversations(userId: string, query?: string, limit = 200): ConversationSummary[] {
    const q = query?.trim();
    if (!q) {
      return (
        this.db
          .prepare(
            `SELECT id,title,title_locked,created_at,updated_at FROM conversations
             WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?`,
          )
          .all(userId, limit) as ConvRow[]
      ).map(toSummary);
    }
    const like = `%${likeEscape(q.slice(0, 100))}%`;
    return (
      this.db
        .prepare(
          `SELECT id,title,title_locked,created_at,updated_at FROM conversations c
           WHERE user_id = @userId AND (
             title LIKE @like ESCAPE '\\' OR
             EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.content LIKE @like ESCAPE '\\')
           ) ORDER BY updated_at DESC LIMIT @limit`,
        )
        .all({ userId, like, limit }) as ConvRow[]
    ).map(toSummary);
  }
  getConversation(userId: string, convId: string): (ConversationSummary & { titleLocked: boolean }) | null {
    const r = this.db
      .prepare('SELECT id,title,title_locked,created_at,updated_at FROM conversations WHERE id = ? AND user_id = ?')
      .get(convId, userId) as ConvRow | undefined;
    return r ? { ...toSummary(r), titleLocked: !!r.title_locked } : null;
  }
  getConversationDetail(userId: string, convId: string): ConversationDetail | null {
    const c = this.getConversation(userId, convId);
    if (!c) return null;
    return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messages: this.listMessages(convId) };
  }
  renameConversation(userId: string, convId: string, title: string): boolean {
    return (
      this.db
        .prepare('UPDATE conversations SET title = ?, title_locked = 1 WHERE id = ? AND user_id = ?')
        .run(title, convId, userId).changes > 0
    );
  }
  setGeneratedTitle(convId: string, title: string): boolean {
    return (
      this.db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND title_locked = 0').run(title, convId).changes > 0
    );
  }
  touchConversation(convId: string) {
    this.db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now(), convId);
  }
  deleteConversation(userId: string, convId: string): boolean {
    return this.db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?').run(convId, userId).changes > 0;
  }
  deleteAllConversations(userId: string): number {
    return this.db.prepare('DELETE FROM conversations WHERE user_id = ?').run(userId).changes;
  }

  // ---- messages ----
  listMessages(convId: string): ChatMessage[] {
    return (
      this.db
        .prepare(
          'SELECT id,conversation_id,role,content,status,sources,created_at FROM messages WHERE conversation_id = ? ORDER BY seq',
        )
        .all(convId) as MessageRow[]
    ).map(toMessage);
  }
  getMessage(convId: string, messageId: string): ChatMessage | null {
    const r = this.db
      .prepare(
        'SELECT id,conversation_id,role,content,status,sources,created_at FROM messages WHERE id = ? AND conversation_id = ?',
      )
      .get(messageId, convId) as MessageRow | undefined;
    return r ? toMessage(r) : null;
  }
  addMessage(
    convId: string,
    m: { role: Role; content: string; status?: MessageStatus; sources?: Source[]; id?: string },
  ): ChatMessage {
    const row = this.db.transaction(() => {
      const seq =
        ((this.db.prepare('SELECT MAX(seq) s FROM messages WHERE conversation_id = ?').get(convId) as { s: number | null }).s ??
          0) + 1;
      const mid = m.id ?? id();
      const t = now();
      this.db
        .prepare(
          'INSERT INTO messages (id,conversation_id,seq,role,content,status,sources,created_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(mid, convId, seq, m.role, m.content, m.status ?? 'complete', JSON.stringify(m.sources ?? []), t);
      this.touchConversation(convId);
      return mid;
    })();
    return this.getMessage(convId, row)!;
  }
  updateMessage(messageId: string, patch: { content?: string; status?: MessageStatus; sources?: Source[] }) {
    const cur = this.db.prepare('SELECT content,status,sources FROM messages WHERE id = ?').get(messageId) as
      | { content: string; status: string; sources: string }
      | undefined;
    if (!cur) return;
    this.db
      .prepare('UPDATE messages SET content = ?, status = ?, sources = ? WHERE id = ?')
      .run(
        patch.content ?? cur.content,
        patch.status ?? cur.status,
        patch.sources ? JSON.stringify(patch.sources) : cur.sources,
        messageId,
      );
  }
  /** Delete every message after (and optionally including) the given one. */
  truncateAfter(convId: string, messageId: string, inclusive = false) {
    const r = this.db.prepare('SELECT seq FROM messages WHERE id = ? AND conversation_id = ?').get(messageId, convId) as
      | { seq: number }
      | undefined;
    if (!r) return;
    this.db
      .prepare(`DELETE FROM messages WHERE conversation_id = ? AND seq ${inclusive ? '>=' : '>'} ?`)
      .run(convId, r.seq);
  }
  deleteMessage(messageId: string) {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  }
}

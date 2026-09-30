import type { Pool, PoolClient } from 'pg';

export interface Migration {
  version: number;
  name: string;
  up: (client: PoolClient | Pool) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: '001_initial_schema',
    up: async (db) => {
      await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          email TEXT UNIQUE,
          password_hash TEXT,
          token_hash TEXT UNIQUE,
          display_name TEXT NOT NULL DEFAULT '',
          custom_instructions TEXT NOT NULL DEFAULT '',
          memory_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at BIGINT NOT NULL,
          expires_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          title_locked INTEGER NOT NULL DEFAULT 0,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
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
          attachments TEXT NOT NULL DEFAULT '[]',
          created_at BIGINT NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);
        CREATE INDEX IF NOT EXISTS idx_msg_conv_created ON messages(conversation_id, created_at);

        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
          message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          size_bytes BIGINT NOT NULL,
          storage_key TEXT NOT NULL,
          storage_type TEXT NOT NULL DEFAULT 'local',
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_user ON attachments(user_id);

        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);

        CREATE TABLE IF NOT EXISTS generated_images (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          prompt TEXT NOT NULL,
          revised_prompt TEXT,
          storage_key TEXT NOT NULL,
          storage_type TEXT NOT NULL DEFAULT 'local',
          mime_type TEXT NOT NULL DEFAULT 'image/png',
          created_at BIGINT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_generated_images_user ON generated_images(user_id, created_at DESC);
      `);
    },
  },
];

export async function runMigrations(pool: Pool): Promise<number> {
  const tableCheck = await pool.query(
    `SELECT 1 FROM information_schema.tables WHERE table_name = 'schema_migrations'`,
  );
  if (!tableCheck.rows.length) {
    await pool.query(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at BIGINT NOT NULL
      );
    `);
  }

  const { rows } = await pool.query<{ version: number }>('SELECT version FROM schema_migrations ORDER BY version ASC');
  const applied = new Set(rows.map((r) => Number(r.version)));

  let count = 0;
  for (const migration of MIGRATIONS) {
    if (!applied.has(migration.version)) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await migration.up(client);
        await client.query(
          'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
          [migration.version, migration.name, Date.now()],
        );
        await client.query('COMMIT');
        count++;
        console.log(`[db] applied migration ${migration.version}: ${migration.name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`[db] migration ${migration.version} failed:`, err);
        throw err;
      } finally {
        client.release();
      }
    }
  }

  return count;
}

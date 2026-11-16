import { DatabaseClient } from '../client';

export interface Migration {
  id: string;
  name: string;
  upSql: string;
}

export const INITIAL_MIGRATION: Migration = {
  id: '001',
  name: '001_initial_schema',
  upSql: `
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'reviewer', 'viewer')),
      password_hash TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS contestants (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('foundation_model', 'coding_agent', 'research_agent', 'platform')),
      adapter_type TEXT NOT NULL CHECK (adapter_type IN ('api', 'cli', 'platform')),
      provider TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('connected', 'unconfigured', 'error', 'disabled')),
      status_reason TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      is_enabled INTEGER NOT NULL DEFAULT 1,
      last_checked_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
      id TEXT PRIMARY KEY,
      action_type TEXT NOT NULL CHECK (
        action_type IN (
          'adapter_activation',
          'spend_cap_change',
          'permission_change',
          'external_write',
          'competition_budget'
        )
      ),
      target_resource TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
      requested_by_user_id TEXT NOT NULL REFERENCES users(id),
      decided_by_user_id TEXT REFERENCES users(id),
      decision_note TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      expires_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_created_at ON approval_requests(created_at);

    CREATE TABLE IF NOT EXISTS audit_logs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system', 'adapter')),
      actor_id TEXT NOT NULL,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);

    CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'audit_logs is append-only: updates are forbidden');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'audit_logs is append-only: deletions are forbidden');
    END;
  `,
};

export const ALL_MIGRATIONS: Migration[] = [INITIAL_MIGRATION];

export async function runMigrations(db: DatabaseClient): Promise<string | null> {
  await db.execRaw(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = await db.query<{ id: string; name: string }>(
    'SELECT id, name FROM _migrations ORDER BY id ASC',
  );
  const appliedIds = new Set(applied.map((row) => row.id));

  for (const migration of ALL_MIGRATIONS) {
    if (!appliedIds.has(migration.id)) {
      await db.transaction(async (tx) => {
        await tx.execRaw(migration.upSql);
        await tx.execute(
          'INSERT INTO _migrations (id, name, applied_at) VALUES ($1, $2, $3)',
          [migration.id, migration.name, new Date().toISOString()],
        );
      });
    }
  }

  const latest = await db.queryOne<{ id: string; name: string }>(
    'SELECT id, name FROM _migrations ORDER BY id DESC LIMIT 1',
  );
  return latest ? latest.name : null;
}

export async function getLatestMigrationName(db: DatabaseClient): Promise<string | null> {
  const row = await db.queryOne<{ name: string }>(
    'SELECT name FROM _migrations ORDER BY id DESC LIMIT 1',
  );
  return row ? row.name : null;
}

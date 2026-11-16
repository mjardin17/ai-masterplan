import { DatabaseClient } from '../client';
import { INITIAL_MIGRATION, Migration } from './001_initial_schema';

export const MILESTONE2_MIGRATION: Migration = {
  id: '002',
  name: '002_milestone2_arena',
  upSql: `
    CREATE TABLE IF NOT EXISTS benchmark_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL CHECK (
        category IN ('coding', 'reasoning', 'research', 'debugging', 'security', 'recovery')
      ),
      description TEXT NOT NULL,
      instructions TEXT NOT NULL,
      starting_files_json TEXT NOT NULL,
      acceptance_checks_json TEXT NOT NULL,
      time_limit_ms INTEGER NOT NULL,
      token_budget INTEGER NOT NULL,
      cost_cap_usd REAL NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_benchmark_tasks_category ON benchmark_tasks(category);

    CREATE TABLE IF NOT EXISTS competitions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      task_id TEXT NOT NULL REFERENCES benchmark_tasks(id),
      category TEXT NOT NULL CHECK (
        category IN ('coding', 'reasoning', 'research', 'debugging', 'security', 'recovery')
      ),
      status TEXT NOT NULL CHECK (
        status IN ('draft', 'awaiting_approval', 'approved', 'running', 'completed', 'failed', 'cancelled')
      ),
      approval_request_id TEXT REFERENCES approval_requests(id),
      time_limit_ms INTEGER NOT NULL,
      token_budget INTEGER NOT NULL,
      cost_cap_usd REAL NOT NULL,
      created_by_user_id TEXT NOT NULL REFERENCES users(id),
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_competitions_status ON competitions(status);
    CREATE INDEX IF NOT EXISTS idx_competitions_category ON competitions(category);

    CREATE TABLE IF NOT EXISTS competition_entries (
      id TEXT PRIMARY KEY,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      contestant_id TEXT NOT NULL REFERENCES contestants(id),
      contestant_status_snapshot TEXT NOT NULL,
      workspace_path TEXT,
      status TEXT NOT NULL CHECK (
        status IN ('pending', 'running', 'completed', 'failed', 'timed_out', 'blocked')
      ),
      is_test_fixture INTEGER NOT NULL DEFAULT 0,
      modified_files_json TEXT NOT NULL DEFAULT '[]',
      execution_time_ms INTEGER,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      estimated_cost_usd REAL NOT NULL DEFAULT 0,
      error_message TEXT,
      started_at TEXT,
      finished_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(competition_id, contestant_id)
    );

    CREATE INDEX IF NOT EXISTS idx_entries_competition ON competition_entries(competition_id);
    CREATE INDEX IF NOT EXISTS idx_entries_contestant ON competition_entries(contestant_id);

    CREATE TABLE IF NOT EXISTS verification_reports (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL REFERENCES competition_entries(id) ON DELETE CASCADE,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      contestant_id TEXT NOT NULL REFERENCES contestants(id),
      verifier_id TEXT NOT NULL,
      passed INTEGER NOT NULL CHECK (passed IN (0, 1)),
      exit_code INTEGER,
      tests_passed INTEGER NOT NULL DEFAULT 0,
      tests_failed INTEGER NOT NULL DEFAULT 0,
      tests_total INTEGER NOT NULL DEFAULT 0,
      checks_json TEXT NOT NULL,
      stdout_excerpt TEXT NOT NULL,
      stderr_excerpt TEXT NOT NULL,
      diff_summary_json TEXT NOT NULL,
      evidence_hash TEXT NOT NULL,
      execution_time_ms INTEGER NOT NULL,
      verified_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_verifications_entry ON verification_reports(entry_id);

    CREATE TABLE IF NOT EXISTS competition_scores (
      id TEXT PRIMARY KEY,
      entry_id TEXT NOT NULL UNIQUE REFERENCES competition_entries(id) ON DELETE CASCADE,
      competition_id TEXT NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
      contestant_id TEXT NOT NULL REFERENCES contestants(id),
      category TEXT NOT NULL,
      verification_report_id TEXT NOT NULL REFERENCES verification_reports(id),
      correctness_score REAL NOT NULL,
      reliability_score REAL NOT NULL,
      speed_score REAL NOT NULL,
      resource_score REAL NOT NULL,
      composite_score REAL NOT NULL,
      raw_metrics_json TEXT NOT NULL,
      scoring_rule_version TEXT NOT NULL,
      is_eligible_for_leaderboard INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_scores_leaderboard
      ON competition_scores(is_eligible_for_leaderboard, category, contestant_id);

    CREATE TABLE IF NOT EXISTS learning_observations (
      id TEXT PRIMARY KEY,
      competition_id TEXT REFERENCES competitions(id) ON DELETE SET NULL,
      entry_id TEXT REFERENCES competition_entries(id) ON DELETE SET NULL,
      contestant_id TEXT NOT NULL REFERENCES contestants(id),
      category TEXT NOT NULL,
      observation_type TEXT NOT NULL CHECK (
        observation_type IN ('success_pattern', 'failure', 'blocker', 'correction')
      ),
      summary TEXT NOT NULL,
      details_json TEXT NOT NULL,
      evidence_report_id TEXT REFERENCES verification_reports(id),
      promotion_status TEXT NOT NULL DEFAULT 'captured' CHECK (promotion_status IN ('captured')),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_observations_contestant ON learning_observations(contestant_id);
  `,
};

export const ALL_ARENA_MIGRATIONS: Migration[] = [
  INITIAL_MIGRATION,
  MILESTONE2_MIGRATION,
];

export async function runAllMigrations(db: DatabaseClient): Promise<string | null> {
  await db.execRaw(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = await db.query<{ id: string }>(
    'SELECT id FROM _migrations ORDER BY id ASC',
  );
  const appliedIds = new Set(applied.map((r) => r.id));

  for (const migration of ALL_ARENA_MIGRATIONS) {
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

  const latest = await db.queryOne<{ name: string }>(
    'SELECT name FROM _migrations ORDER BY id DESC LIMIT 1',
  );
  return latest ? latest.name : null;
}

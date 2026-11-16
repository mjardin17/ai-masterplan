import crypto from 'node:crypto';
import {
  AcceptanceCheckSpec,
  ApprovalStatus,
  ArenaCategory,
  BenchmarkTaskDTO,
  CheckExecutionOutcome,
  CompetitionDTO,
  CompetitionEntryDTO,
  CompetitionEntryStatus,
  CompetitionScoreDTO,
  CompetitionStatus,
  ContestantStatus,
  FileDiffSummary,
  LeaderboardRowDTO,
  LearningObservationDTO,
  LearningObservationType,
  VerificationReportDTO,
} from '../../../shared/types';
import { DatabaseClient, SqlParam } from '../client';

interface TaskRow {
  id: string;
  title: string;
  category: ArenaCategory;
  description: string;
  instructions: string;
  starting_files_json: string;
  acceptance_checks_json: string;
  time_limit_ms: number;
  token_budget: number;
  cost_cap_usd: number;
  created_by_user_id: string;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

interface CompetitionRow {
  id: string;
  title: string;
  task_id: string;
  task_title: string | null;
  category: ArenaCategory;
  status: CompetitionStatus;
  approval_request_id: string | null;
  approval_status: ApprovalStatus | null;
  time_limit_ms: number;
  token_budget: number;
  cost_cap_usd: number;
  created_by_user_id: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  entry_count?: number;
}

interface EntryRow {
  id: string;
  competition_id: string;
  contestant_id: string;
  contestant_name: string | null;
  contestant_status_snapshot: ContestantStatus;
  workspace_path: string | null;
  status: CompetitionEntryStatus;
  is_test_fixture: number;
  modified_files_json: string;
  execution_time_ms: number | null;
  tokens_in: number;
  tokens_out: number;
  estimated_cost_usd: number;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

interface ReportRow {
  id: string;
  entry_id: string;
  competition_id: string;
  contestant_id: string;
  verifier_id: string;
  passed: number;
  exit_code: number | null;
  tests_passed: number;
  tests_failed: number;
  tests_total: number;
  checks_json: string;
  stdout_excerpt: string;
  stderr_excerpt: string;
  diff_summary_json: string;
  evidence_hash: string;
  execution_time_ms: number;
  verified_at: string;
}

interface ScoreRow {
  id: string;
  entry_id: string;
  competition_id: string;
  contestant_id: string;
  category: ArenaCategory;
  verification_report_id: string;
  correctness_score: number;
  reliability_score: number;
  speed_score: number;
  resource_score: number;
  composite_score: number;
  raw_metrics_json: string;
  scoring_rule_version: string;
  is_eligible_for_leaderboard: number;
  created_at: string;
}

interface ObservationRow {
  id: string;
  competition_id: string | null;
  entry_id: string | null;
  contestant_id: string;
  category: ArenaCategory;
  observation_type: LearningObservationType;
  summary: string;
  details_json: string;
  evidence_report_id: string | null;
  promotion_status: 'captured';
  created_at: string;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toTaskDTO(row: TaskRow): BenchmarkTaskDTO {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    description: row.description,
    instructions: row.instructions,
    startingFiles: safeJsonParse<Record<string, string>>(row.starting_files_json, {}),
    acceptanceChecks: safeJsonParse<AcceptanceCheckSpec[]>(row.acceptance_checks_json, []),
    timeLimitMs: Number(row.time_limit_ms),
    tokenBudget: Number(row.token_budget),
    costCapUsd: Number(row.cost_cap_usd),
    createdByUserId: row.created_by_user_id,
    createdByEmail: row.created_by_email ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toCompetitionDTO(row: CompetitionRow): CompetitionDTO {
  return {
    id: row.id,
    title: row.title,
    taskId: row.task_id,
    taskTitle: row.task_title ?? undefined,
    category: row.category,
    status: row.status,
    approvalRequestId: row.approval_request_id,
    approvalStatus: row.approval_status,
    timeLimitMs: Number(row.time_limit_ms),
    tokenBudget: Number(row.token_budget),
    costCapUsd: Number(row.cost_cap_usd),
    createdByUserId: row.created_by_user_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    entryCount: row.entry_count !== undefined ? Number(row.entry_count) : undefined,
  };
}

function toEntryDTO(row: EntryRow): CompetitionEntryDTO {
  return {
    id: row.id,
    competitionId: row.competition_id,
    contestantId: row.contestant_id,
    contestantName: row.contestant_name ?? undefined,
    contestantStatusSnapshot: row.contestant_status_snapshot,
    workspacePath: row.workspace_path,
    status: row.status,
    isTestFixture: row.is_test_fixture === 1,
    modifiedFiles: safeJsonParse<string[]>(row.modified_files_json, []),
    executionTimeMs: row.execution_time_ms !== null ? Number(row.execution_time_ms) : null,
    tokensIn: Number(row.tokens_in),
    tokensOut: Number(row.tokens_out),
    estimatedCostUsd: Number(row.estimated_cost_usd),
    errorMessage: row.error_message,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

function toReportDTO(row: ReportRow): VerificationReportDTO {
  return {
    id: row.id,
    entryId: row.entry_id,
    competitionId: row.competition_id,
    contestantId: row.contestant_id,
    verifierId: row.verifier_id,
    passed: row.passed === 1,
    exitCode: row.exit_code !== null ? Number(row.exit_code) : null,
    testsPassed: Number(row.tests_passed),
    testsFailed: Number(row.tests_failed),
    testsTotal: Number(row.tests_total),
    checks: safeJsonParse<CheckExecutionOutcome[]>(row.checks_json, []),
    stdoutExcerpt: row.stdout_excerpt,
    stderrExcerpt: row.stderr_excerpt,
    diffSummary: safeJsonParse<FileDiffSummary>(row.diff_summary_json, {
      created: [],
      modified: [],
      deleted: [],
      unchangedCount: 0,
    }),
    evidenceHash: row.evidence_hash,
    executionTimeMs: Number(row.execution_time_ms),
    verifiedAt: row.verified_at,
  };
}

function toScoreDTO(row: ScoreRow): CompetitionScoreDTO {
  return {
    id: row.id,
    entryId: row.entry_id,
    competitionId: row.competition_id,
    contestantId: row.contestant_id,
    category: row.category,
    verificationReportId: row.verification_report_id,
    correctnessScore: Number(row.correctness_score),
    reliabilityScore: Number(row.reliability_score),
    speedScore: Number(row.speed_score),
    resourceScore: Number(row.resource_score),
    compositeScore: Number(row.composite_score),
    rawMetrics: safeJsonParse<Record<string, unknown>>(row.raw_metrics_json, {}),
    scoringRuleVersion: row.scoring_rule_version,
    isEligibleForLeaderboard: row.is_eligible_for_leaderboard === 1,
    createdAt: row.created_at,
  };
}

function toObservationDTO(row: ObservationRow): LearningObservationDTO {
  return {
    id: row.id,
    competitionId: row.competition_id,
    entryId: row.entry_id,
    contestantId: row.contestant_id,
    category: row.category,
    observationType: row.observation_type,
    summary: row.summary,
    details: safeJsonParse<Record<string, unknown>>(row.details_json, {}),
    evidenceReportId: row.evidence_report_id,
    promotionStatus: row.promotion_status,
    createdAt: row.created_at,
  };
}

export class ArenaRepository {
  constructor(private readonly db: DatabaseClient) {}

  async createTask(input: {
    title: string;
    category: ArenaCategory;
    description: string;
    instructions: string;
    startingFiles: Record<string, string>;
    acceptanceChecks: AcceptanceCheckSpec[];
    timeLimitMs: number;
    tokenBudget: number;
    costCapUsd: number;
    createdByUserId: string;
  }): Promise<BenchmarkTaskDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO benchmark_tasks (
        id, title, category, description, instructions, starting_files_json,
        acceptance_checks_json, time_limit_ms, token_budget, cost_cap_usd,
        created_by_user_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        id,
        input.title.trim(),
        input.category,
        input.description.trim(),
        input.instructions.trim(),
        JSON.stringify(input.startingFiles),
        JSON.stringify(input.acceptanceChecks),
        input.timeLimitMs,
        input.tokenBudget,
        input.costCapUsd,
        input.createdByUserId,
        now,
        now,
      ],
    );
    const created = await this.findTaskById(id);
    if (!created) throw new Error('Failed to load created benchmark task');
    return created;
  }

  async findTaskById(id: string): Promise<BenchmarkTaskDTO | null> {
    const row = await this.db.queryOne<TaskRow>(
      `SELECT t.*, u.email AS created_by_email
       FROM benchmark_tasks t
       LEFT JOIN users u ON u.id = t.created_by_user_id
       WHERE t.id = $1`,
      [id],
    );
    return row ? toTaskDTO(row) : null;
  }

  async listTasks(category?: ArenaCategory): Promise<BenchmarkTaskDTO[]> {
    const params: SqlParam[] = [];
    const whereSql = category ? 'WHERE t.category = $1' : '';
    if (category) params.push(category);
    const rows = await this.db.query<TaskRow>(
      `SELECT t.*, u.email AS created_by_email
       FROM benchmark_tasks t
       LEFT JOIN users u ON u.id = t.created_by_user_id
       ${whereSql}
       ORDER BY t.created_at DESC`,
      params,
    );
    return rows.map(toTaskDTO);
  }

  async createCompetition(input: {
    title: string;
    taskId: string;
    category: ArenaCategory;
    status: CompetitionStatus;
    approvalRequestId: string | null;
    timeLimitMs: number;
    tokenBudget: number;
    costCapUsd: number;
    createdByUserId: string;
  }): Promise<CompetitionDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO competitions (
        id, title, task_id, category, status, approval_request_id,
        time_limit_ms, token_budget, cost_cap_usd, created_by_user_id,
        started_at, finished_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL, $11, $12)`,
      [
        id,
        input.title.trim(),
        input.taskId,
        input.category,
        input.status,
        input.approvalRequestId,
        input.timeLimitMs,
        input.tokenBudget,
        input.costCapUsd,
        input.createdByUserId,
        now,
        now,
      ],
    );
    const created = await this.findCompetitionById(id);
    if (!created) throw new Error('Failed to load created competition');
    return created;
  }

  async findCompetitionById(id: string): Promise<CompetitionDTO | null> {
    const row = await this.db.queryOne<CompetitionRow>(
      `SELECT c.*, t.title AS task_title, a.status AS approval_status,
              (SELECT COUNT(*) FROM competition_entries e WHERE e.competition_id = c.id) AS entry_count
       FROM competitions c
       LEFT JOIN benchmark_tasks t ON t.id = c.task_id
       LEFT JOIN approval_requests a ON a.id = c.approval_request_id
       WHERE c.id = $1`,
      [id],
    );
    return row ? toCompetitionDTO(row) : null;
  }

  async listCompetitions(category?: ArenaCategory): Promise<CompetitionDTO[]> {
    const params: SqlParam[] = [];
    const whereSql = category ? 'WHERE c.category = $1' : '';
    if (category) params.push(category);
    const rows = await this.db.query<CompetitionRow>(
      `SELECT c.*, t.title AS task_title, a.status AS approval_status,
              (SELECT COUNT(*) FROM competition_entries e WHERE e.competition_id = c.id) AS entry_count
       FROM competitions c
       LEFT JOIN benchmark_tasks t ON t.id = c.task_id
       LEFT JOIN approval_requests a ON a.id = c.approval_request_id
       ${whereSql}
       ORDER BY c.created_at DESC`,
      params,
    );
    return rows.map(toCompetitionDTO);
  }

  async updateCompetitionStatus(
    id: string,
    status: CompetitionStatus,
    timestamps?: { startedAt?: string | null; finishedAt?: string | null },
  ): Promise<CompetitionDTO | null> {
    const existing = await this.findCompetitionById(id);
    if (!existing) return null;
    const now = new Date().toISOString();
    await this.db.execute(
      `UPDATE competitions
       SET status = $1,
           started_at = COALESCE($2, started_at),
           finished_at = COALESCE($3, finished_at),
           updated_at = $4
       WHERE id = $5`,
      [
        status,
        timestamps?.startedAt ?? null,
        timestamps?.finishedAt ?? null,
        now,
        id,
      ],
    );
    return this.findCompetitionById(id);
  }

  async createEntry(input: {
    competitionId: string;
    contestantId: string;
    contestantStatusSnapshot: ContestantStatus;
    isTestFixture?: boolean;
  }): Promise<CompetitionEntryDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO competition_entries (
        id, competition_id, contestant_id, contestant_status_snapshot, workspace_path,
        status, is_test_fixture, modified_files_json, execution_time_ms,
        tokens_in, tokens_out, estimated_cost_usd, error_message,
        started_at, finished_at, created_at
      ) VALUES ($1, $2, $3, $4, NULL, 'pending', $5, '[]', NULL, 0, 0, 0, NULL, NULL, NULL, $6)`,
      [
        id,
        input.competitionId,
        input.contestantId,
        input.contestantStatusSnapshot,
        input.isTestFixture ? 1 : 0,
        now,
      ],
    );
    const created = await this.findEntryById(id);
    if (!created) throw new Error('Failed to load created competition entry');
    return created;
  }

  async findEntryById(id: string): Promise<CompetitionEntryDTO | null> {
    const row = await this.db.queryOne<EntryRow>(
      `SELECT e.*, con.name AS contestant_name
       FROM competition_entries e
       LEFT JOIN contestants con ON con.id = e.contestant_id
       WHERE e.id = $1`,
      [id],
    );
    return row ? toEntryDTO(row) : null;
  }

  async listEntriesByCompetition(competitionId: string): Promise<CompetitionEntryDTO[]> {
    const rows = await this.db.query<EntryRow>(
      `SELECT e.*, con.name AS contestant_name
       FROM competition_entries e
       LEFT JOIN contestants con ON con.id = e.contestant_id
       WHERE e.competition_id = $1
       ORDER BY e.created_at ASC`,
      [competitionId],
    );
    return rows.map(toEntryDTO);
  }

  async updateEntryExecution(
    entryId: string,
    updates: {
      workspacePath?: string;
      status: CompetitionEntryStatus;
      modifiedFiles?: string[];
      executionTimeMs?: number | null;
      tokensIn?: number;
      tokensOut?: number;
      estimatedCostUsd?: number;
      errorMessage?: string | null;
      startedAt?: string | null;
      finishedAt?: string | null;
    },
  ): Promise<CompetitionEntryDTO | null> {
    await this.db.execute(
      `UPDATE competition_entries
       SET workspace_path = COALESCE($1, workspace_path),
           status = $2,
           modified_files_json = COALESCE($3, modified_files_json),
           execution_time_ms = COALESCE($4, execution_time_ms),
           tokens_in = COALESCE($5, tokens_in),
           tokens_out = COALESCE($6, tokens_out),
           estimated_cost_usd = COALESCE($7, estimated_cost_usd),
           error_message = $8,
           started_at = COALESCE($9, started_at),
           finished_at = COALESCE($10, finished_at)
       WHERE id = $11`,
      [
        updates.workspacePath ?? null,
        updates.status,
        updates.modifiedFiles ? JSON.stringify(updates.modifiedFiles) : null,
        updates.executionTimeMs ?? null,
        updates.tokensIn ?? null,
        updates.tokensOut ?? null,
        updates.estimatedCostUsd ?? null,
        updates.errorMessage ?? null,
        updates.startedAt ?? null,
        updates.finishedAt ?? null,
        entryId,
      ],
    );
    return this.findEntryById(entryId);
  }

  async saveVerificationReport(input: {
    entryId: string;
    competitionId: string;
    contestantId: string;
    verifierId: string;
    passed: boolean;
    exitCode: number | null;
    testsPassed: number;
    testsFailed: number;
    testsTotal: number;
    checks: CheckExecutionOutcome[];
    stdoutExcerpt: string;
    stderrExcerpt: string;
    diffSummary: FileDiffSummary;
    evidenceHash: string;
    executionTimeMs: number;
  }): Promise<VerificationReportDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO verification_reports (
        id, entry_id, competition_id, contestant_id, verifier_id, passed,
        exit_code, tests_passed, tests_failed, tests_total, checks_json,
        stdout_excerpt, stderr_excerpt, diff_summary_json, evidence_hash,
        execution_time_ms, verified_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        id,
        input.entryId,
        input.competitionId,
        input.contestantId,
        input.verifierId,
        input.passed ? 1 : 0,
        input.exitCode,
        input.testsPassed,
        input.testsFailed,
        input.testsTotal,
        JSON.stringify(input.checks),
        input.stdoutExcerpt,
        input.stderrExcerpt,
        JSON.stringify(input.diffSummary),
        input.evidenceHash,
        input.executionTimeMs,
        now,
      ],
    );
    const row = await this.db.queryOne<ReportRow>(
      'SELECT * FROM verification_reports WHERE id = $1',
      [id],
    );
    if (!row) throw new Error('Failed to load verification report');
    return toReportDTO(row);
  }

  async listReportsByCompetition(competitionId: string): Promise<VerificationReportDTO[]> {
    const rows = await this.db.query<ReportRow>(
      'SELECT * FROM verification_reports WHERE competition_id = $1 ORDER BY verified_at ASC',
      [competitionId],
    );
    return rows.map(toReportDTO);
  }

  async saveScore(input: {
    entryId: string;
    competitionId: string;
    contestantId: string;
    category: ArenaCategory;
    verificationReportId: string;
    correctnessScore: number;
    reliabilityScore: number;
    speedScore: number;
    resourceScore: number;
    compositeScore: number;
    rawMetrics: Record<string, unknown>;
    scoringRuleVersion: string;
    isEligibleForLeaderboard: boolean;
  }): Promise<CompetitionScoreDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO competition_scores (
        id, entry_id, competition_id, contestant_id, category, verification_report_id,
        correctness_score, reliability_score, speed_score, resource_score,
        composite_score, raw_metrics_json, scoring_rule_version,
        is_eligible_for_leaderboard, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        id,
        input.entryId,
        input.competitionId,
        input.contestantId,
        input.category,
        input.verificationReportId,
        input.correctnessScore,
        input.reliabilityScore,
        input.speedScore,
        input.resourceScore,
        input.compositeScore,
        JSON.stringify(input.rawMetrics),
        input.scoringRuleVersion,
        input.isEligibleForLeaderboard ? 1 : 0,
        now,
      ],
    );
    const row = await this.db.queryOne<ScoreRow>(
      'SELECT * FROM competition_scores WHERE id = $1',
      [id],
    );
    if (!row) throw new Error('Failed to load competition score');
    return toScoreDTO(row);
  }

  async listScoresByCompetition(competitionId: string): Promise<CompetitionScoreDTO[]> {
    const rows = await this.db.query<ScoreRow>(
      'SELECT * FROM competition_scores WHERE competition_id = $1 ORDER BY composite_score DESC',
      [competitionId],
    );
    return rows.map(toScoreDTO);
  }

  async createObservation(input: {
    competitionId: string | null;
    entryId: string | null;
    contestantId: string;
    category: ArenaCategory;
    observationType: LearningObservationType;
    summary: string;
    details: Record<string, unknown>;
    evidenceReportId: string | null;
  }): Promise<LearningObservationDTO> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO learning_observations (
        id, competition_id, entry_id, contestant_id, category, observation_type,
        summary, details_json, evidence_report_id, promotion_status, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'captured', $10)`,
      [
        id,
        input.competitionId,
        input.entryId,
        input.contestantId,
        input.category,
        input.observationType,
        input.summary.trim(),
        JSON.stringify(input.details),
        input.evidenceReportId,
        now,
      ],
    );
    const row = await this.db.queryOne<ObservationRow>(
      'SELECT * FROM learning_observations WHERE id = $1',
      [id],
    );
    if (!row) throw new Error('Failed to load learning observation');
    return toObservationDTO(row);
  }

  async listObservations(options?: {
    competitionId?: string;
    contestantId?: string;
    limit?: number;
  }): Promise<LearningObservationDTO[]> {
    const where: string[] = [];
    const params: SqlParam[] = [];
    let idx = 1;
    if (options?.competitionId) {
      where.push(`competition_id = $${idx++}`);
      params.push(options.competitionId);
    }
    if (options?.contestantId) {
      where.push(`contestant_id = $${idx++}`);
      params.push(options.contestantId);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(Math.max(options?.limit ?? 100, 1), 200);
    const rows = await this.db.query<ObservationRow>(
      `SELECT * FROM learning_observations ${whereSql} ORDER BY created_at DESC LIMIT $${idx}`,
      [...params, limit],
    );
    return rows.map(toObservationDTO);
  }

  /**
   * Queries persistent leaderboard strictly from verified competition scores
   * for connected, non-fixture contestants. Unconfigured/disabled/error contestants
   * and test fixtures are never ranked.
   */
  async getLeaderboard(options?: {
    category?: ArenaCategory;
    includeTestFixturesForTest?: boolean;
  }): Promise<LeaderboardRowDTO[]> {
    const where: string[] = [
      "con.status = 'connected'",
      's.is_eligible_for_leaderboard = 1',
    ];
    if (!options?.includeTestFixturesForTest) {
      where.push('e.is_test_fixture = 0');
    }
    const params: SqlParam[] = [];
    let idx = 1;
    if (options?.category) {
      where.push(`s.category = $${idx++}`);
      params.push(options.category);
    }

    const rows = await this.db.query<{
      contestant_id: string;
      contestant_name: string;
      provider: string;
      status: ContestantStatus;
      runs_count: number;
      passed_count: number;
      avg_composite: number;
      avg_correctness: number;
      avg_reliability: number;
      avg_speed: number;
      avg_resource: number;
      latest_report_id: string;
      latest_competition_id: string;
      last_verified_at: string;
    }>(
      `SELECT
         con.id AS contestant_id,
         con.name AS contestant_name,
         con.provider AS provider,
         con.status AS status,
         COUNT(*) AS runs_count,
         SUM(CASE WHEN r.passed = 1 THEN 1 ELSE 0 END) AS passed_count,
         ROUND(AVG(s.composite_score), 2) AS avg_composite,
         ROUND(AVG(s.correctness_score), 2) AS avg_correctness,
         ROUND(AVG(s.reliability_score), 2) AS avg_reliability,
         ROUND(AVG(s.speed_score), 2) AS avg_speed,
         ROUND(AVG(s.resource_score), 2) AS avg_resource,
         MAX(r.id) AS latest_report_id,
         MAX(s.competition_id) AS latest_competition_id,
         MAX(r.verified_at) AS last_verified_at
       FROM competition_scores s
       INNER JOIN competition_entries e ON e.id = s.entry_id
       INNER JOIN verification_reports r ON r.id = s.verification_report_id
       INNER JOIN contestants con ON con.id = s.contestant_id
       WHERE ${where.join(' AND ')}
       GROUP BY con.id, con.name, con.provider, con.status
       ORDER BY avg_composite DESC, passed_count DESC, avg_speed DESC`,
      params,
    );

    return rows.map((row) => {
      const runsCount = Number(row.runs_count);
      const passedCount = Number(row.passed_count);
      return {
        contestantId: row.contestant_id,
        contestantName: row.contestant_name,
        provider: row.provider,
        status: row.status,
        runsCount,
        passedCount,
        passRate: runsCount > 0 ? Math.round((passedCount / runsCount) * 10000) / 100 : 0,
        avgCompositeScore: Number(row.avg_composite),
        avgCorrectnessScore: Number(row.avg_correctness),
        avgReliabilityScore: Number(row.avg_reliability),
        avgSpeedScore: Number(row.avg_speed),
        avgResourceScore: Number(row.avg_resource),
        latestReportId: row.latest_report_id,
        latestCompetitionId: row.latest_competition_id,
        lastVerifiedAt: row.last_verified_at,
      };
    });
  }
}

import {
  AcceptanceCheckSpec,
  ArenaCategory,
  BenchmarkTaskDTO,
  CompetitionDetailDTO,
  CompetitionDTO,
  CompetitionEntryStatus,
  LeaderboardRowDTO,
  LearningObservationDTO,
  PublicUser,
} from '../../shared/types';
import { ApprovalsService } from '../approvals/service';
import { sanitizeErrorMessage } from '../config/env';
import { ArenaRepository } from '../db/repositories/arenaRepo';
import { AuditRepository } from '../db/repositories/auditRepo';
import { ContestantsRepository } from '../db/repositories/contestantsRepo';
import { LearningObservationRecorder } from '../learning/observations';
import { ScopedWorkspaceHandle, WorkspaceManager } from '../sandbox/workspaceManager';
import { calculateEntryScore } from '../scoring/engine';
import { runIndependentVerification } from '../verification/verifier';

export class ArenaServiceError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ArenaServiceError';
  }
}

export interface CompetitionExecutorContext {
  competitionId: string;
  entryId: string;
  category: ArenaCategory;
  instructions: string;
  timeLimitMs: number;
  tokenBudget: number;
  costCapUsd: number;
  workspace: ScopedWorkspaceHandle;
}

export interface CompetitionExecutorResult {
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
}

export type CompetitionEntryExecutor = (
  ctx: CompetitionExecutorContext,
) => Promise<CompetitionExecutorResult>;

const VALID_CATEGORIES: ArenaCategory[] = [
  'coding',
  'reasoning',
  'research',
  'debugging',
  'security',
  'recovery',
];

export class ArenaService {
  private readonly observationRecorder: LearningObservationRecorder;

  constructor(
    private readonly arenaRepo: ArenaRepository,
    private readonly contestantsRepo: ContestantsRepository,
    private readonly approvalsService: ApprovalsService,
    private readonly auditRepo: AuditRepository,
    private readonly workspaceManager: WorkspaceManager,
    private readonly allowPaidLiveExecution = false,
  ) {
    this.observationRecorder = new LearningObservationRecorder(arenaRepo);
  }

  async listTasks(category?: ArenaCategory): Promise<BenchmarkTaskDTO[]> {
    return this.arenaRepo.listTasks(category);
  }

  async createTask(
    actor: PublicUser,
    input: {
      title: string;
      category: ArenaCategory;
      description: string;
      instructions: string;
      startingFiles: Record<string, string>;
      acceptanceChecks: AcceptanceCheckSpec[];
      timeLimitMs: number;
      tokenBudget: number;
      costCapUsd: number;
    },
  ): Promise<BenchmarkTaskDTO> {
    if (!input.title || input.title.trim().length < 3) {
      throw new ArenaServiceError(400, 'Task title must be at least 3 characters.');
    }
    if (!VALID_CATEGORIES.includes(input.category)) {
      throw new ArenaServiceError(400, `Invalid category: ${input.category}`);
    }
    if (!input.instructions || input.instructions.trim().length < 10) {
      throw new ArenaServiceError(400, 'Task instructions must be at least 10 characters.');
    }
    if (!Array.isArray(input.acceptanceChecks) || input.acceptanceChecks.length === 0) {
      throw new ArenaServiceError(400, 'At least one independent acceptance check is required.');
    }
    if (!Number.isFinite(input.timeLimitMs) || input.timeLimitMs < 500 || input.timeLimitMs > 120_000) {
      throw new ArenaServiceError(400, 'timeLimitMs must be between 500 and 120000.');
    }
    if (!Number.isFinite(input.tokenBudget) || input.tokenBudget < 100) {
      throw new ArenaServiceError(400, 'tokenBudget must be at least 100.');
    }
    if (!Number.isFinite(input.costCapUsd) || input.costCapUsd < 0) {
      throw new ArenaServiceError(400, 'costCapUsd must be non-negative.');
    }

    const task = await this.arenaRepo.createTask({
      title: input.title,
      category: input.category,
      description: input.description || input.title,
      instructions: input.instructions,
      startingFiles: input.startingFiles ?? {},
      acceptanceChecks: input.acceptanceChecks,
      timeLimitMs: Math.round(input.timeLimitMs),
      tokenBudget: Math.round(input.tokenBudget),
      costCapUsd: input.costCapUsd,
      createdByUserId: actor.id,
    });

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: 'arena.task_created',
      resourceType: 'benchmark_task',
      resourceId: task.id,
      metadata: {
        title: task.title,
        category: task.category,
        checksCount: task.acceptanceChecks.length,
      },
    });

    return task;
  }

  async listCompetitions(category?: ArenaCategory): Promise<CompetitionDTO[]> {
    return this.arenaRepo.listCompetitions(category);
  }

  async getCompetitionDetail(competitionId: string): Promise<CompetitionDetailDTO> {
    const competition = await this.arenaRepo.findCompetitionById(competitionId);
    if (!competition) {
      throw new ArenaServiceError(404, 'Competition not found.');
    }
    const task = await this.arenaRepo.findTaskById(competition.taskId);
    if (!task) {
      throw new ArenaServiceError(404, 'Benchmark task not found.');
    }
    const [entries, reports, scores, observations] = await Promise.all([
      this.arenaRepo.listEntriesByCompetition(competitionId),
      this.arenaRepo.listReportsByCompetition(competitionId),
      this.arenaRepo.listScoresByCompetition(competitionId),
      this.arenaRepo.listObservations({ competitionId }),
    ]);

    return {
      competition,
      task,
      entries,
      reports,
      scores,
      observations,
    };
  }

  async stageCompetition(
    actor: PublicUser,
    input: {
      title: string;
      taskId: string;
      contestantIds: string[];
      requestApproval?: boolean;
      isTestFixture?: boolean;
    },
  ): Promise<CompetitionDetailDTO> {
    if (!input.title || input.title.trim().length < 3) {
      throw new ArenaServiceError(400, 'Competition title must be at least 3 characters.');
    }
    const task = await this.arenaRepo.findTaskById(input.taskId);
    if (!task) {
      throw new ArenaServiceError(404, 'Benchmark task not found.');
    }

    const uniqueContestantIds = Array.from(new Set(input.contestantIds ?? []));
    if (uniqueContestantIds.length === 0) {
      throw new ArenaServiceError(400, 'Select at least one configured contestant.');
    }

    const contestants = [];
    for (const cid of uniqueContestantIds) {
      const c = await this.contestantsRepo.findById(cid);
      if (!c) {
        throw new ArenaServiceError(404, `Contestant not found: ${cid}`);
      }
      if (!input.isTestFixture && c.status !== 'connected') {
        throw new ArenaServiceError(
          400,
          `Contestant "${c.name}" is ${c.status} and cannot enter a live competition.`,
        );
      }
      contestants.push(c);
    }

    let approvalRequestId: string | null = null;
    let initialStatus: CompetitionDTO['status'] = 'draft';

    if (input.requestApproval !== false && !input.isTestFixture) {
      const approval = await this.approvalsService.createRequest(actor, {
        actionType: 'competition_budget',
        targetResource: `task:${task.id}`,
        summary: `Authorize competition "${input.title.trim()}" (cap $${task.costCapUsd.toFixed(2)}, ${uniqueContestantIds.length} contestants)`,
        payload: {
          taskId: task.id,
          category: task.category,
          contestantIds: uniqueContestantIds,
          costCapUsd: task.costCapUsd,
          tokenBudget: task.tokenBudget,
        },
      });
      approvalRequestId = approval.id;
      initialStatus = 'awaiting_approval';
    }

    const competition = await this.arenaRepo.createCompetition({
      title: input.title,
      taskId: task.id,
      category: task.category,
      status: initialStatus,
      approvalRequestId,
      timeLimitMs: task.timeLimitMs,
      tokenBudget: task.tokenBudget,
      costCapUsd: task.costCapUsd,
      createdByUserId: actor.id,
    });

    for (const c of contestants) {
      await this.arenaRepo.createEntry({
        competitionId: competition.id,
        contestantId: c.id,
        contestantStatusSnapshot: c.status,
        isTestFixture: Boolean(input.isTestFixture),
      });
    }

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: 'arena.competition_staged',
      resourceType: 'competition',
      resourceId: competition.id,
      metadata: {
        taskId: task.id,
        category: task.category,
        contestantIds: uniqueContestantIds,
        approvalRequestId,
        isTestFixture: Boolean(input.isTestFixture),
      },
    });

    return this.getCompetitionDetail(competition.id);
  }

  async launchLiveCompetition(actor: PublicUser, competitionId: string): Promise<never> {
    const detail = await this.getCompetitionDetail(competitionId);
    if (detail.competition.approvalStatus !== 'approved') {
      throw new ArenaServiceError(
        403,
        'Human approval is required before launching any competition.',
      );
    }

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: 'arena.live_launch_blocked_by_policy',
      resourceType: 'competition',
      resourceId: competitionId,
      metadata: { allowPaidLiveExecution: this.allowPaidLiveExecution },
    });

    throw new ArenaServiceError(
      403,
      'Paid AI model competitions are disabled in Milestone 2 by policy. Infrastructure verification runs only via isolated test fixtures.',
    );
  }

  /**
   * Executes a staged competition using explicitly supplied isolated executors
   * (used by automated Milestone 2 verification suites with deterministic test-only adapters).
   */
  async executeWithExecutors(
    actor: PublicUser,
    competitionId: string,
    executorsByContestant: Record<string, CompetitionEntryExecutor>,
  ): Promise<CompetitionDetailDTO> {
    const detail = await this.getCompetitionDetail(competitionId);
    const { competition, task, entries } = detail;

    const startedAt = new Date().toISOString();
    await this.arenaRepo.updateCompetitionStatus(competitionId, 'running', { startedAt });

    for (const entry of entries) {
      const executor = executorsByContestant[entry.contestantId];
      if (!executor) {
        throw new ArenaServiceError(
          400,
          `Missing executor for contestant ${entry.contestantId}`,
        );
      }

      const provisioned = this.workspaceManager.provisionEntryWorkspace(
        competitionId,
        entry.id,
        task.startingFiles,
      );
      const entryStartMs = Date.now();
      const entryStartedIso = new Date().toISOString();

      await this.arenaRepo.updateEntryExecution(entry.id, {
        workspacePath: provisioned.workspaceRoot,
        status: 'running',
        startedAt: entryStartedIso,
      });

      let entryStatus: CompetitionEntryStatus = 'completed';
      let errorMessage: string | null = null;
      let tokensIn = 0;
      let tokensOut = 0;
      let estimatedCostUsd = 0;

      try {
        const execPromise = executor({
          competitionId,
          entryId: entry.id,
          category: task.category,
          instructions: task.instructions,
          timeLimitMs: task.timeLimitMs,
          tokenBudget: task.tokenBudget,
          costCapUsd: task.costCapUsd,
          workspace: provisioned.handle,
        });

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`ENTRY_TIMEOUT: exceeded ${task.timeLimitMs}ms`)),
            task.timeLimitMs,
          ),
        );

        const result = await Promise.race([execPromise, timeoutPromise]);
        tokensIn = result.tokensIn;
        tokensOut = result.tokensOut;
        estimatedCostUsd = result.estimatedCostUsd;
      } catch (err) {
        const safe = sanitizeErrorMessage(err);
        errorMessage = safe;
        if (safe.startsWith('ENTRY_TIMEOUT:')) {
          entryStatus = 'timed_out';
        } else if (safe.toLowerCase().includes('outside workspace') || safe.toLowerCase().includes('symlink')) {
          entryStatus = 'blocked';
        } else {
          entryStatus = 'failed';
        }
      }

      const executionTimeMs = Date.now() - entryStartMs;
      const finishedIso = new Date().toISOString();
      const diffSummary = provisioned.captureDiff();
      const modifiedFiles = [...diffSummary.created, ...diffSummary.modified];

      const updatedEntry = await this.arenaRepo.updateEntryExecution(entry.id, {
        workspacePath: provisioned.workspaceRoot,
        status: entryStatus,
        modifiedFiles,
        executionTimeMs,
        tokensIn,
        tokensOut,
        estimatedCostUsd,
        errorMessage,
        finishedAt: finishedIso,
      });

      const reportOutput = await runIndependentVerification({
        entryId: entry.id,
        workspaceRoot: provisioned.workspaceRoot,
        checks: task.acceptanceChecks,
        diffSummary,
        timeLimitMs: task.timeLimitMs,
        entryTimedOut: entryStatus === 'timed_out',
        entryErrored: entryStatus === 'failed' || entryStatus === 'blocked',
      });

      const report = await this.arenaRepo.saveVerificationReport({
        entryId: entry.id,
        competitionId,
        contestantId: entry.contestantId,
        verifierId: reportOutput.verifierId,
        passed: reportOutput.passed,
        exitCode: reportOutput.exitCode,
        testsPassed: reportOutput.testsPassed,
        testsFailed: reportOutput.testsFailed,
        testsTotal: reportOutput.testsTotal,
        checks: reportOutput.checks,
        stdoutExcerpt: reportOutput.stdoutExcerpt,
        stderrExcerpt: reportOutput.stderrExcerpt,
        diffSummary,
        evidenceHash: reportOutput.evidenceHash,
        executionTimeMs: reportOutput.executionTimeMs,
      });

      const liveContestant = await this.contestantsRepo.findById(entry.contestantId);
      const score = calculateEntryScore({
        category: task.category,
        entryStatus,
        contestantStatus: liveContestant?.status ?? entry.contestantStatusSnapshot,
        isTestFixture: entry.isTestFixture,
        executionTimeMs,
        timeLimitMs: task.timeLimitMs,
        tokensUsed: tokensIn + tokensOut,
        tokenBudget: task.tokenBudget,
        estimatedCostUsd,
        costCapUsd: task.costCapUsd,
        report,
      });

      await this.arenaRepo.saveScore({
        entryId: entry.id,
        competitionId,
        contestantId: entry.contestantId,
        category: task.category,
        verificationReportId: report.id,
        correctnessScore: score.correctnessScore,
        reliabilityScore: score.reliabilityScore,
        speedScore: score.speedScore,
        resourceScore: score.resourceScore,
        compositeScore: score.compositeScore,
        rawMetrics: score.rawMetrics,
        scoringRuleVersion: score.scoringRuleVersion,
        isEligibleForLeaderboard: score.isEligibleForLeaderboard,
      });

      if (updatedEntry) {
        await this.observationRecorder.recordFromVerification({
          competitionId,
          category: task.category,
          entry: updatedEntry,
          report,
        });
      }
    }

    await this.arenaRepo.updateCompetitionStatus(competitionId, 'completed', {
      finishedAt: new Date().toISOString(),
    });

    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: 'arena.competition_verified',
      resourceType: 'competition',
      resourceId: competitionId,
      metadata: {
        category: competition.category,
        entryCount: entries.length,
      },
    });

    return this.getCompetitionDetail(competitionId);
  }

  async getLeaderboard(options?: {
    category?: ArenaCategory;
    includeTestFixturesForTest?: boolean;
  }): Promise<LeaderboardRowDTO[]> {
    return this.arenaRepo.getLeaderboard(options);
  }

  async listObservations(options?: {
    competitionId?: string;
    contestantId?: string;
    limit?: number;
  }): Promise<LearningObservationDTO[]> {
    return this.arenaRepo.listObservations(options);
  }
}

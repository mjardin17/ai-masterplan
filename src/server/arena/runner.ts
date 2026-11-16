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
import {
  ScopedWorkspaceHandle,
  WorkspaceManager,
  WorkspaceSecurityError,
} from '../sandbox/workspaceManager';
import {
  assertExecutionAllowedForTrustTier,
  detectSandboxCapabilities,
  ExecutionTrustTier,
  SandboxCapabilities,
  SandboxIsolationError,
} from '../sandbox/isolation';
import { calculateEntryScore } from '../scoring/engine';
import { runIndependentVerification } from '../verification/verifier';
import { TaskValidationError, validateBenchmarkTaskInput } from './validation';

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
  signal: AbortSignal;
}

export interface CompetitionExecutorResult {
  tokensIn: number;
  tokensOut: number;
  estimatedCostUsd: number;
}

export type CompetitionEntryExecutor = (
  ctx: CompetitionExecutorContext,
) => Promise<CompetitionExecutorResult>;

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

  getIsolationCapabilities(): SandboxCapabilities {
    return detectSandboxCapabilities();
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
    let validated;
    try {
      validated = validateBenchmarkTaskInput(input);
    } catch (err) {
      throw new ArenaServiceError(
        400,
        err instanceof TaskValidationError ? err.message : 'Invalid benchmark task specification.',
      );
    }

    const task = await this.arenaRepo.createTask({
      title: validated.title,
      category: validated.category,
      description: validated.description,
      instructions: validated.instructions,
      startingFiles: validated.startingFiles,
      acceptanceChecks: validated.acceptanceChecks,
      timeLimitMs: validated.timeLimitMs,
      tokenBudget: validated.tokenBudget,
      costCapUsd: validated.costCapUsd,
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
        startingFilesCount: Object.keys(task.startingFiles).length,
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

    const caps = this.getIsolationCapabilities();
    await this.auditRepo.append({
      actorType: 'user',
      actorId: actor.id,
      actorRole: actor.role,
      action: 'arena.live_launch_blocked_by_policy',
      resourceType: 'competition',
      resourceId: competitionId,
      metadata: {
        allowPaidLiveExecution: this.allowPaidLiveExecution,
        untrustedContestantExecutionPermitted: caps.untrustedContestantExecutionPermitted,
        missingMechanisms: caps.missingMechanisms,
      },
    });

    if (!this.allowPaidLiveExecution) {
      throw new ArenaServiceError(
        403,
        'Paid AI model competitions are disabled in Milestone 2 by policy. Infrastructure verification runs only via isolated test fixtures.',
      );
    }

    try {
      assertExecutionAllowedForTrustTier('untrusted_contestant', caps);
    } catch (err) {
      throw new ArenaServiceError(
        403,
        err instanceof SandboxIsolationError
          ? err.message
          : 'Live competition launch blocked by fail-closed isolation policy.',
      );
    }

    throw new ArenaServiceError(
      403,
      'Live AI contestant execution is blocked by fail-closed policy.',
    );
  }

  /**
   * Executes a staged competition using explicitly supplied isolated executors
   * (used by verification suites with deterministic test-only adapters).
   * Rejects `trustTier: 'untrusted_contestant'` fail-closed when a dedicated
   * external OS/container sandbox is unavailable.
   */
  async executeWithExecutors(
    actor: PublicUser,
    competitionId: string,
    executorsByContestant: Record<string, CompetitionEntryExecutor>,
    options?: {
      trustTier?: ExecutionTrustTier;
      signal?: AbortSignal;
    },
  ): Promise<CompetitionDetailDTO> {
    const trustTier: ExecutionTrustTier = options?.trustTier ?? 'trusted_local_test';
    try {
      assertExecutionAllowedForTrustTier(trustTier, this.getIsolationCapabilities());
    } catch (err) {
      throw new ArenaServiceError(
        403,
        err instanceof SandboxIsolationError ? err.message : 'Execution blocked by isolation policy.',
      );
    }

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

      const abortController = new AbortController();
      const parentSignal = options?.signal;
      const onParentAbort = () => {
        abortController.abort(
          parentSignal?.reason instanceof Error
            ? parentSignal.reason
            : new Error('ENTRY_TIMEOUT: competition execution aborted'),
        );
      };
      if (parentSignal) {
        if (parentSignal.aborted) {
          onParentAbort();
        } else {
          parentSignal.addEventListener('abort', onParentAbort, { once: true });
        }
      }

      let timeoutTimer: NodeJS.Timeout | null = null;
      let timedOutAbort = false;

      const execPromise = Promise.resolve().then(() =>
        executor({
          competitionId,
          entryId: entry.id,
          category: task.category,
          instructions: task.instructions,
          timeLimitMs: task.timeLimitMs,
          tokenBudget: task.tokenBudget,
          costCapUsd: task.costCapUsd,
          workspace: provisioned.handle,
          signal: abortController.signal,
        }),
      );
      // Prevent unhandled rejections if the underlying promise rejects after timeout settles
      execPromise.catch(() => undefined);

      try {
        const abortPromise = new Promise<never>((_, reject) => {
          const rejectWithReason = () => {
            timedOutAbort = true;
            const reason = abortController.signal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error(`ENTRY_TIMEOUT: exceeded ${task.timeLimitMs}ms`),
            );
          };
          if (abortController.signal.aborted) {
            rejectWithReason();
            return;
          }
          abortController.signal.addEventListener('abort', rejectWithReason, { once: true });
        });

        timeoutTimer = setTimeout(() => {
          abortController.abort(new Error(`ENTRY_TIMEOUT: exceeded ${task.timeLimitMs}ms`));
        }, task.timeLimitMs);

        const result = await Promise.race([execPromise, abortPromise]);
        tokensIn = result.tokensIn;
        tokensOut = result.tokensOut;
        estimatedCostUsd = result.estimatedCostUsd;
      } catch (err) {
        const safe = sanitizeErrorMessage(err);
        errorMessage = safe;
        if (timedOutAbort || safe.startsWith('ENTRY_TIMEOUT:')) {
          entryStatus = 'timed_out';
        } else if (
          err instanceof WorkspaceSecurityError ||
          err instanceof SandboxIsolationError ||
          safe.toLowerCase().includes('outside workspace') ||
          safe.toLowerCase().includes('symlink')
        ) {
          entryStatus = 'blocked';
        } else {
          entryStatus = 'failed';
        }
      } finally {
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
        }
        if (parentSignal) {
          parentSignal.removeEventListener('abort', onParentAbort);
        }
      }

      if (abortController.signal.aborted) {
        // Give abort listeners (e.g. child process-group SIGKILL) bounded time to finish reaping PIDs
        let cleanupTimer: NodeJS.Timeout | null = null;
        await Promise.race([
          execPromise.catch(() => undefined),
          new Promise<void>((resolve) => {
            cleanupTimer = setTimeout(resolve, 150);
            cleanupTimer.unref();
          }),
        ]);
        if (cleanupTimer) clearTimeout(cleanupTimer);
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
        signal: options?.signal,
        trustTier: 'trusted_local_test',
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

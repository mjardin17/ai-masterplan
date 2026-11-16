import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GeminiAdapter } from '../src/server/adapters/geminiAdapter';
import { ContestantRegistry } from '../src/server/adapters/registry';
import { createPlaceholderRosterAdapters } from '../src/server/adapters/unconfiguredAdapters';
import { ApprovalsService } from '../src/server/approvals/service';
import { ArenaService } from '../src/server/arena/runner';
import { createSqliteClient } from '../src/server/db/client';
import { runAllMigrations } from '../src/server/db/migrations/002_milestone2_arena';
import { ApprovalsRepository } from '../src/server/db/repositories/approvalsRepo';
import { ArenaRepository } from '../src/server/db/repositories/arenaRepo';
import { AuditRepository } from '../src/server/db/repositories/auditRepo';
import { ContestantsRepository } from '../src/server/db/repositories/contestantsRepo';
import { UsersRepository } from '../src/server/db/repositories/usersRepo';
import { WorkspaceManager } from '../src/server/sandbox/workspaceManager';
import { calculateEntryScore, SCORING_RULE_VERSION } from '../src/server/scoring/engine';

test('calculateEntryScore separates correctness, reliability, speed, and resource dimensions and filters unconfigured/fixture entries', () => {
  const connectedFastPass = calculateEntryScore({
    category: 'coding',
    entryStatus: 'completed',
    contestantStatus: 'connected',
    isTestFixture: false,
    executionTimeMs: 400,
    timeLimitMs: 4000,
    tokensUsed: 500,
    tokenBudget: 4000,
    estimatedCostUsd: 0.02,
    costCapUsd: 0.5,
    report: {
      passed: true,
      exitCode: 0,
      testsPassed: 3,
      testsTotal: 3,
      checks: [
        { checkId: 'c1', label: 't', type: 'node_test', passed: true, exitCode: 0, durationMs: 50, details: 'ok' },
      ],
    },
  });

  assert.equal(connectedFastPass.correctnessScore, 100);
  assert.equal(connectedFastPass.reliabilityScore, 100);
  assert.equal(connectedFastPass.speedScore, 100);
  assert.equal(connectedFastPass.resourceScore, 100);
  assert.equal(connectedFastPass.compositeScore, 100);
  assert.equal(connectedFastPass.scoringRuleVersion, SCORING_RULE_VERSION);
  assert.equal(connectedFastPass.isEligibleForLeaderboard, true);
  assert.equal(connectedFastPass.rawMetrics.testsPassed, 3);

  const unconfiguredOrTimedOut = calculateEntryScore({
    category: 'security',
    entryStatus: 'timed_out',
    contestantStatus: 'unconfigured',
    isTestFixture: true,
    executionTimeMs: 5000,
    timeLimitMs: 4000,
    tokensUsed: 0,
    tokenBudget: 4000,
    estimatedCostUsd: 0,
    costCapUsd: 0.5,
    report: {
      passed: false,
      exitCode: null,
      testsPassed: 0,
      testsTotal: 3,
      checks: [
        { checkId: 'c1', label: 't', type: 'node_test', passed: false, exitCode: null, durationMs: 0, details: 'timeout' },
      ],
    },
  });

  assert.equal(unconfiguredOrTimedOut.correctnessScore, 0);
  assert.equal(unconfiguredOrTimedOut.reliabilityScore, 0);
  assert.equal(unconfiguredOrTimedOut.speedScore, 0);
  assert.equal(unconfiguredOrTimedOut.resourceScore, 0);
  assert.equal(unconfiguredOrTimedOut.compositeScore, 0);
  assert.equal(unconfiguredOrTimedOut.isEligibleForLeaderboard, false);
});

test('ArenaService runs deterministic test-only competition harness end-to-end with isolated workspaces, verification, scoring, observations, and leaderboard exclusion', async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-e2e-'));
  const db = createSqliteClient(':memory:');

  try {
    const latest = await runAllMigrations(db);
    assert.equal(latest, '002_milestone2_arena');

    const usersRepo = new UsersRepository(db);
    const contestantsRepo = new ContestantsRepository(db);
    const auditRepo = new AuditRepository(db);
    const approvalsRepo = new ApprovalsRepository(db);
    const arenaRepo = new ArenaRepository(db);

    const admin = await usersRepo.create({
      email: 'arena-admin@masterplan.local',
      displayName: 'Arena Admin',
      role: 'admin',
      passwordHash: 'hash',
    });

    const registry = new ContestantRegistry(contestantsRepo, auditRepo, [
      new GeminiAdapter({ getApiKey: () => null }),
      ...createPlaceholderRosterAdapters(),
    ]);
    await registry.syncAll();

    // Mark gemini as connected in DB strictly for deterministic harness testing (no live API calls)
    await contestantsRepo.updateHealth(
      'gemini',
      'connected',
      'Test harness connected override',
      new Date().toISOString(),
    );

    const approvalsService = new ApprovalsService(approvalsRepo, usersRepo, auditRepo);
    const workspaceManager = new WorkspaceManager(sandboxRoot);
    const arenaService = new ArenaService(
      arenaRepo,
      contestantsRepo,
      approvalsService,
      auditRepo,
      workspaceManager,
      false,
    );

    const task = await arenaService.createTask(admin, {
      title: 'Fix Buggy Subtract Function',
      category: 'debugging',
      description: 'Fix subtract(a, b) in solution.mjs without introducing eval.',
      instructions: 'Implement subtract(a, b) returning a - b in solution.mjs and ensure unit tests pass.',
      startingFiles: {
        'solution.mjs': 'export function subtract(a, b) { return a + b; }\n',
        'solution.test.mjs': `
          import test from 'node:test';
          import assert from 'node:assert/strict';
          import { subtract } from './solution.mjs';
          test('subtracts positive numbers', () => assert.equal(subtract(10, 3), 7));
          test('subtracts negative numbers', () => assert.equal(subtract(-4, -6), 2));
        `,
      },
      acceptanceChecks: [
        { id: 'tests', label: 'Node unit tests', type: 'node_test', targetPath: 'solution.test.mjs' },
        { id: 'sec', label: 'Security scan', type: 'security_scan', targetPath: 'solution.mjs' },
      ],
      timeLimitMs: 2500,
      tokenBudget: 2000,
      costCapUsd: 0.25,
    });

    // Stage with isTestFixture: true so test-only executors are explicitly marked & never ranked as real contestants
    const staged = await arenaService.stageCompetition(admin, {
      title: 'Harness Verification Run #1',
      taskId: task.id,
      contestantIds: ['gemini', 'claude', 'openai-codex', 'grok'],
      requestApproval: false,
      isTestFixture: true,
    });

    assert.equal(staged.entries.length, 4);
    assert.ok(staged.entries.every((e) => e.isTestFixture === true));

    const result = await arenaService.executeWithExecutors(admin, staged.competition.id, {
      // 1. Passing executor (connected snapshot, marked fixture)
      gemini: async (ctx) => {
        // Verify identical instructions delivered to every contestant
        assert.equal(ctx.instructions, task.instructions);
        ctx.workspace.writeFile('solution.mjs', 'export function subtract(a, b) { return a - b; }\n');
        return { tokensIn: 120, tokensOut: 40, estimatedCostUsd: 0.002 };
      },
      // 2. Failing executor (unconfigured snapshot, wrong logic)
      claude: async (ctx) => {
        assert.equal(ctx.instructions, task.instructions);
        ctx.workspace.writeFile('solution.mjs', 'export function subtract(a, b) { return a * b; }\n');
        return { tokensIn: 150, tokensOut: 60, estimatedCostUsd: 0.003 };
      },
      // 3. Blocked path-escape executor
      'openai-codex': async (ctx) => {
        ctx.workspace.writeFile('../escape.txt', 'should be blocked');
        return { tokensIn: 50, tokensOut: 10, estimatedCostUsd: 0 };
      },
      // 4. Slow timed-out executor
      grok: async () => {
        await new Promise((r) => setTimeout(r, 3200));
        return { tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 };
      },
    });

    assert.equal(result.competition.status, 'completed');
    assert.equal(result.reports.length, 4);
    assert.equal(result.scores.length, 4);
    assert.equal(result.observations.length, 4);

    const byContestant = new Map(result.entries.map((e) => [e.contestantId, e]));
    const reportByContestant = new Map(result.reports.map((r) => [r.contestantId, r]));
    const scoreByContestant = new Map(result.scores.map((s) => [s.contestantId, s]));
    const obsByContestant = new Map(result.observations.map((o) => [o.contestantId, o]));

    // Passing entry verified independently
    assert.equal(byContestant.get('gemini')?.status, 'completed');
    assert.deepEqual(byContestant.get('gemini')?.modifiedFiles, ['solution.mjs']);
    assert.equal(reportByContestant.get('gemini')?.passed, true);
    assert.equal(reportByContestant.get('gemini')?.testsPassed, 2);
    assert.equal(scoreByContestant.get('gemini')?.correctnessScore, 100);
    assert.equal(obsByContestant.get('gemini')?.observationType, 'success_pattern');
    assert.equal(obsByContestant.get('gemini')?.promotionStatus, 'captured');

    // Failing logic entry recorded exitCode=1 and failed tests
    assert.equal(byContestant.get('claude')?.status, 'completed');
    assert.equal(reportByContestant.get('claude')?.passed, false);
    assert.equal(reportByContestant.get('claude')?.testsFailed, 2);
    assert.equal(obsByContestant.get('claude')?.observationType, 'failure');

    // Path-escape entry blocked cleanly
    assert.equal(byContestant.get('openai-codex')?.status, 'blocked');
    assert.equal(reportByContestant.get('openai-codex')?.passed, false);
    assert.equal(obsByContestant.get('openai-codex')?.observationType, 'blocker');

    // Timeout entry marked timed_out
    assert.equal(byContestant.get('grok')?.status, 'timed_out');
    assert.equal(reportByContestant.get('grok')?.passed, false);
    assert.equal(obsByContestant.get('grok')?.observationType, 'blocker');

    // Real leaderboard MUST remain empty because all entries were test fixtures (and 3 were unconfigured)
    assert.equal(scoreByContestant.get('gemini')?.isEligibleForLeaderboard, false);
    const publicLeaderboard = await arenaService.getLeaderboard();
    assert.equal(publicLeaderboard.length, 0);

    // Explicitly verify getLeaderboard ranks connected, non-fixture verified entries and excludes unconfigured ones
    const prodTask = await arenaService.stageCompetition(admin, {
      title: 'Eligibility Verification Stage',
      taskId: task.id,
      contestantIds: ['gemini'],
      requestApproval: false,
      isTestFixture: false,
    });
    const prodResult = await arenaService.executeWithExecutors(admin, prodTask.competition.id, {
      gemini: async (ctx) => {
        ctx.workspace.writeFile('solution.mjs', 'export function subtract(a, b) { return a - b; }\n');
        return { tokensIn: 100, tokensOut: 30, estimatedCostUsd: 0.001 };
      },
    });
    assert.equal(prodResult.scores[0].isEligibleForLeaderboard, true);
    const ranked = await arenaService.getLeaderboard({ category: 'debugging' });
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].contestantId, 'gemini');
    assert.equal(ranked[0].passRate, 100);

    // Audit chain intact
    const chain = await auditRepo.verifyChain();
    assert.equal(chain.valid, true);
  } finally {
    await db.close();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

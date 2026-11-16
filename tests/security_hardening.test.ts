import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GeminiAdapter } from '../src/server/adapters/geminiAdapter';
import { ContestantRegistry } from '../src/server/adapters/registry';
import { createPlaceholderRosterAdapters } from '../src/server/adapters/unconfiguredAdapters';
import { createBackendApp } from '../src/server/app';
import { ApprovalsService } from '../src/server/approvals/service';
import { ArenaService, ArenaServiceError } from '../src/server/arena/runner';
import { getServerConfig } from '../src/server/config/env';
import { createSqliteClient } from '../src/server/db/client';
import { runAllMigrations } from '../src/server/db/migrations/002_milestone2_arena';
import { ApprovalsRepository } from '../src/server/db/repositories/approvalsRepo';
import { ArenaRepository } from '../src/server/db/repositories/arenaRepo';
import { AuditRepository } from '../src/server/db/repositories/auditRepo';
import { ContestantsRepository } from '../src/server/db/repositories/contestantsRepo';
import { UsersRepository } from '../src/server/db/repositories/usersRepo';
import { runAllowlistedWorkspaceCommand } from '../src/server/sandbox/commandRunner';
import {
  detectSandboxCapabilities,
  SandboxIsolationError,
} from '../src/server/sandbox/isolation';
import { WorkspaceManager } from '../src/server/sandbox/workspaceManager';

function createTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function findHostPidsMatching(marker: string): number[] {
  const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
  const pids: number[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes(marker) || line.includes('ps -eo')) continue;
    const match = line.trim().match(/^(\d+)\s+/);
    if (match) {
      pids.push(Number.parseInt(match[1], 10));
    }
  }
  return pids;
}

function assertPidGone(pid: number): void {
  assert.throws(
    () => {
      process.kill(pid, 0);
    },
    (err: NodeJS.ErrnoException) => err.code === 'ESRCH',
  );
}

async function startArenaHttpServer(sandboxRoot: string) {
  const config = getServerConfig({
    NODE_ENV: 'test',
    SQLITE_PATH: ':memory:',
    SESSION_SECRET: 'security-hardening-test-secret-0123456789',
    SANDBOX_ROOT: sandboxRoot,
  });

  const runtime = await createBackendApp({
    config,
    disableRateLimit: true,
    adapters: [
      new GeminiAdapter({ getApiKey: () => null }),
      ...createPlaceholderRosterAdapters(),
    ],
  });

  const server = http.createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('Failed to bind test HTTP server');
  }

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    runtime,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await runtime.close();
    },
  };
}

function extractCookie(setCookieHeader: string | null): string {
  if (!setCookieHeader) return '';
  return setCookieHeader.split(';')[0] ?? '';
}

test('Benchmark task API rejects unsafe paths, malformed specs, and missing check fields before persistence or workspace creation', async () => {
  const sandboxRoot = createTempDir('arena-sec-val-');
  const srv = await startArenaHttpServer(sandboxRoot);

  try {
    const boot = await fetch(`${srv.baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'sec-admin@arena.test',
        displayName: 'Sec Admin',
        password: 'StrongPassword#2026',
      }),
    });
    assert.equal(boot.status, 201);
    const cookie = extractCookie(boot.headers.get('set-cookie'));

    const invalidPayloads: Array<{ label: string; body: Record<string, unknown> }> = [
      {
        label: 'startingFiles traversal',
        body: {
          title: 'Bad Traversal Task',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { '../escape.mjs': 'console.log(1);' },
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'startingFiles absolute path',
        body: {
          title: 'Bad Abs Path Task',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { '/etc/passwd': 'pwn' },
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'startingFiles backslash',
        body: {
          title: 'Bad Backslash Task',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'sub\\file.mjs': 'x' },
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'startingFiles null byte',
        body: {
          title: 'Bad Null Byte Task',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'file.mjs\0.txt': 'x' },
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'startingFiles non-string content',
        body: {
          title: 'Bad NonString File Task',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 12345 },
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'startingFiles array instead of object',
        body: {
          title: 'Bad StartingFiles Shape',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: ['ok.mjs'],
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'acceptanceCheck traversal targetPath',
        body: {
          title: 'Bad Check Path',
          category: 'security',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 'export const a = 1;' },
          acceptanceChecks: [{ id: 'c1', label: 'escape', type: 'text_contains', targetPath: '../../etc/passwd', needle: 'root' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'acceptanceCheck missing targetPath on node_test',
        body: {
          title: 'Missing Check TargetPath',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 'export const a = 1;' },
          acceptanceChecks: [{ id: 'c1', label: 'tests', type: 'node_test' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'text_contains missing needle',
        body: {
          title: 'Missing Needle',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 'export const a = 1;' },
          acceptanceChecks: [{ id: 'c1', label: 'contains', type: 'text_contains', targetPath: 'ok.mjs', needle: '' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'text_not_contains missing needle',
        body: {
          title: 'Missing Neg Needle',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 'export const a = 1;' },
          acceptanceChecks: [{ id: 'c1', label: 'not contains', type: 'text_not_contains', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'invalid check type',
        body: {
          title: 'Bad Check Type',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 'export const a = 1;' },
          acceptanceChecks: [{ id: 'c1', label: 'exec', type: 'shell_exec', targetPath: 'ok.mjs' }],
          timeLimitMs: 2000,
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
      {
        label: 'malformed numeric limit',
        body: {
          title: 'Bad Numeric Limit',
          category: 'coding',
          instructions: 'Valid instructions long enough.',
          startingFiles: { 'ok.mjs': 'export const a = 1;' },
          acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'file_exists', targetPath: 'ok.mjs' }],
          timeLimitMs: 'not-a-number',
          tokenBudget: 1000,
          costCapUsd: 0.1,
        },
      },
    ];

    for (const tc of invalidPayloads) {
      const res = await fetch(`${srv.baseUrl}/api/arena/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify(tc.body),
      });
      assert.equal(res.status, 400, `Expected 400 for "${tc.label}", got ${res.status}`);
      const errBody = (await res.json()) as { error?: string };
      assert.ok(errBody.error && errBody.error.length > 0, `Missing error message for "${tc.label}"`);
    }

    // Confirm zero tasks persisted and zero workspaces created on disk
    const tasksRes = await fetch(`${srv.baseUrl}/api/arena/tasks`, {
      headers: { Cookie: cookie },
    });
    const tasksJson = (await tasksRes.json()) as { tasks: unknown[] };
    assert.equal(tasksJson.tasks.length, 0);
    assert.deepEqual(fs.readdirSync(sandboxRoot), []);

    // Confirm isolation capability endpoint reports fail-closed posture accurately
    const isoRes = await fetch(`${srv.baseUrl}/api/arena/isolation`, {
      headers: { Cookie: cookie },
    });
    assert.equal(isoRes.status, 200);
    const isoJson = (await isoRes.json()) as {
      isolation: { untrustedContestantExecutionPermitted: boolean; enforcedMechanisms: string[] };
    };
    assert.equal(isoJson.isolation.untrustedContestantExecutionPermitted, false);
    assert.ok(isoJson.isolation.enforcedMechanisms.includes('node_permission_fs_allowlist'));

    // Verify viewer cannot launch competitions via HTTP API (RBAC 403)
    await fetch(`${srv.baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        email: 'sec-viewer@arena.test',
        displayName: 'Sec Viewer',
        role: 'viewer',
        password: 'ViewerPassword#2026',
      }),
    });
    const viewerLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'sec-viewer@arena.test',
        password: 'ViewerPassword#2026',
      }),
    });
    const viewerCookie = extractCookie(viewerLogin.headers.get('set-cookie'));
    const viewerLaunchRes = await fetch(
      `${srv.baseUrl}/api/arena/competitions/nonexistent-comp/launch`,
      { method: 'POST', headers: { Cookie: viewerCookie } },
    );
    assert.equal(viewerLaunchRes.status, 403);
  } finally {
    await srv.close();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('Sandbox command execution enforces host FS block, sibling block, secret isolation, child_process block, network isolation, and resource limits', async () => {
  const sandboxRoot = createTempDir('arena-sec-iso-');
  const prevGeminiKey = process.env.GEMINI_API_KEY;
  const prevSessionSecret = process.env.SESSION_SECRET;
  process.env.GEMINI_API_KEY = 'AIzaLeakedSecretShouldNotAppear12345';
  process.env.SESSION_SECRET = 'SuperSecretSessionValue987654321';

  // Local HTTP listener that the sandboxed child will attempt to reach over loopback
  const probeServer = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('REACHABLE');
  });
  await new Promise<void>((resolve) => probeServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = probeServer.address();
  const probePort = addr && typeof addr !== 'string' ? addr.port : 0;

  try {
    const manager = new WorkspaceManager(sandboxRoot);
    const entryB = manager.provisionEntryWorkspace('comp-iso', 'entry-b', {
      'sibling-secret.txt': 'CONTESTANT_B_PRIVATE_STATE',
    });

    const entryA = manager.provisionEntryWorkspace('comp-iso', 'entry-a', {
      'isolation.test.mjs': `
        import test from 'node:test';
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import { spawnSync } from 'node:child_process';

        const siblingPath = ${JSON.stringify(path.join(entryB.workspaceRoot, 'sibling-secret.txt'))};
        const appPkgPath = ${JSON.stringify(path.resolve(process.cwd(), 'package.json'))};
        const probeUrl = ${JSON.stringify(`http://127.0.0.1:${probePort}/`)};

        test('strips host secrets from env', () => {
          assert.equal(process.env.GEMINI_API_KEY, undefined);
          assert.equal(process.env.SESSION_SECRET, undefined);
        });

        test('blocks reading /etc/passwd, app files, and sibling workspace via Node permission model', () => {
          assert.throws(
            () => fs.readFileSync('/etc/passwd', 'utf8'),
            (err) => err && err.code === 'ERR_ACCESS_DENIED',
          );
          assert.throws(
            () => fs.readFileSync(appPkgPath, 'utf8'),
            (err) => err && err.code === 'ERR_ACCESS_DENIED',
          );
          assert.throws(
            () => fs.readFileSync(siblingPath, 'utf8'),
            (err) => err && err.code === 'ERR_ACCESS_DENIED',
          );
        });

        test('blocks child_process spawning inside permission sandbox', () => {
          assert.throws(
            () => spawnSync('echo', ['hello']),
            (err) => err && err.code === 'ERR_ACCESS_DENIED',
          );
        });

        test('blocks network reachability inside unshare --net namespace', async () => {
          let failed = false;
          try {
            await fetch(probeUrl);
          } catch {
            failed = true;
          }
          assert.equal(failed, true);
        });
      `,
      'fsize.test.mjs': `
        import test from 'node:test';
        import fs from 'node:fs';
        test('cannot exceed prlimit fsize ceiling', () => {
          fs.writeFileSync('huge.bin', Buffer.alloc(64 * 1024, 65));
        });
      `,
      'oom.test.mjs': `
        import test from 'node:test';
        test('exceeds V8 max-old-space-size ceiling', () => {
          const chunks = [];
          while (true) {
            chunks.push(Buffer.alloc(1024 * 1024, 1));
          }
        });
      `,
    });

    const isoResult = await runAllowlistedWorkspaceCommand({
      workspaceRoot: entryA.workspaceRoot,
      commandKey: 'node_test',
      targetPath: 'isolation.test.mjs',
      timeoutMs: 4000,
    });
    assert.equal(
      isoResult.exitCode,
      0,
      `Isolation assertions failed.\nSTDOUT:\n${isoResult.stdout}\nSTDERR:\n${isoResult.stderr}`,
    );
    assert.ok(isoResult.isolationMechanisms.includes('node_permission_fs_allowlist'));
    assert.ok(isoResult.isolationMechanisms.includes('unshare_mount_net_pid_proc'));

    // File size limit enforcement (4096 bytes)
    const fsizeResult = await runAllowlistedWorkspaceCommand({
      workspaceRoot: entryA.workspaceRoot,
      commandKey: 'node_test',
      targetPath: 'fsize.test.mjs',
      timeoutMs: 3000,
      limits: { maxFileSizeBytes: 4096 },
    });
    assert.notEqual(fsizeResult.exitCode, 0);

    // Memory limit enforcement (--max-old-space-size=32)
    const oomResult = await runAllowlistedWorkspaceCommand({
      workspaceRoot: entryA.workspaceRoot,
      commandKey: 'node_test',
      targetPath: 'oom.test.mjs',
      timeoutMs: 4000,
      limits: { maxOldSpaceMb: 32 },
    });
    assert.ok(oomResult.exitCode !== 0 || oomResult.signal !== null);
  } finally {
    if (prevGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = prevGeminiKey;
    if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSessionSecret;

    await new Promise<void>((resolve) => probeServer.close(() => resolve()));
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('AbortController timeout kills child process group with zero orphan processes left behind', async () => {
  const sandboxRoot = createTempDir('arena-sec-abort-');
  const marker = `orphan_${crypto.randomBytes(6).toString('hex')}`;
  const db = createSqliteClient(':memory:');

  try {
    await runAllMigrations(db);
    const usersRepo = new UsersRepository(db);
    const contestantsRepo = new ContestantsRepository(db);
    const auditRepo = new AuditRepository(db);
    const approvalsRepo = new ApprovalsRepository(db);
    const arenaRepo = new ArenaRepository(db);

    const admin = await usersRepo.create({
      email: 'abort-admin@arena.test',
      displayName: 'Abort Admin',
      role: 'admin',
      passwordHash: 'hash',
    });

    const registry = new ContestantRegistry(contestantsRepo, auditRepo, [
      new GeminiAdapter({ getApiKey: () => null }),
      ...createPlaceholderRosterAdapters(),
    ]);
    await registry.syncAll();

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

    const testFilename = `hang_${marker}.test.mjs`;
    const task = await arenaService.createTask(admin, {
      title: 'Cancellation Orphan Check Task',
      category: 'security',
      description: 'Verifies real AbortController cancellation and PGID kill.',
      instructions: 'Ensure long-running subprocess terminates on AbortSignal timeout.',
      startingFiles: {
        [testFilename]: `
          import test from 'node:test';
          import fs from 'node:fs';
          test('hangs while writing started marker', async () => {
            fs.writeFileSync('started.txt', 'running', 'utf8');
            await new Promise((r) => setTimeout(r, 15000));
          });
        `,
      },
      acceptanceChecks: [
        { id: 'hang-test', label: 'Hang check', type: 'node_test', targetPath: testFilename },
      ],
      timeLimitMs: 500,
      tokenBudget: 1000,
      costCapUsd: 0.1,
    });

    const staged = await arenaService.stageCompetition(admin, {
      title: 'Abort Cancellation Stage',
      taskId: task.id,
      contestantIds: ['gemini'],
      requestApproval: false,
      isTestFixture: true,
    });

    let signalRef: AbortSignal | undefined;
    let observedPidsDuringRun: number[] = [];

    const result = await arenaService.executeWithExecutors(admin, staged.competition.id, {
      gemini: async (ctx) => {
        signalRef = ctx.signal;
        // Start observation poller to capture live OS PID before timeout kills the process group
        const pollTimer = setInterval(() => {
          const found = findHostPidsMatching(testFilename);
          if (found.length > 0) {
            observedPidsDuringRun = found;
          }
        }, 25);
        try {
          await runAllowlistedWorkspaceCommand({
            workspaceRoot: ctx.workspace.workspaceRoot,
            commandKey: 'node_test',
            targetPath: testFilename,
            timeoutMs: 10_000,
            signal: ctx.signal,
          });
        } finally {
          clearInterval(pollTimer);
        }
        return { tokensIn: 10, tokensOut: 0, estimatedCostUsd: 0 };
      },
    });

    assert.ok(signalRef);
    assert.equal(signalRef.aborted, true);
    assert.equal(result.entries[0].status, 'timed_out');
    assert.equal(result.reports[0].passed, false);

    assert.ok(
      observedPidsDuringRun.length > 0,
      'Expected to observe active child PID(s) during execution prior to cancellation',
    );

    // Every previously observed PID must be gone and zero matching commands remain
    for (const pid of observedPidsDuringRun) {
      assertPidGone(pid);
    }
    assert.deepEqual(findHostPidsMatching(testFilename), []);
  } finally {
    await db.close();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('Fail-closed policy blocks untrusted_contestant execution when external OS sandbox is absent and blocks unauthorized launch', async () => {
  const sandboxRoot = createTempDir('arena-sec-failclosed-');
  const db = createSqliteClient(':memory:');

  try {
    const caps = detectSandboxCapabilities({ forceRefresh: true });
    assert.equal(caps.untrustedContestantExecutionPermitted, false);
    assert.ok(caps.missingMechanisms.length > 0);

    const manager = new WorkspaceManager(sandboxRoot);
    const ws = manager.provisionEntryWorkspace('comp-fc', 'entry-1', {
      'ok.test.mjs': 'import test from "node:test"; test("ok", () => {});\n',
    });

    await assert.rejects(
      () =>
        runAllowlistedWorkspaceCommand({
          workspaceRoot: ws.workspaceRoot,
          commandKey: 'node_test',
          targetPath: 'ok.test.mjs',
          timeoutMs: 2000,
          trustTier: 'untrusted_contestant',
        }),
      SandboxIsolationError,
    );

    await runAllMigrations(db);
    const usersRepo = new UsersRepository(db);
    const contestantsRepo = new ContestantsRepository(db);
    const auditRepo = new AuditRepository(db);
    const approvalsRepo = new ApprovalsRepository(db);
    const arenaRepo = new ArenaRepository(db);

    const admin = await usersRepo.create({
      email: 'fc-admin@arena.test',
      displayName: 'FC Admin',
      role: 'admin',
      passwordHash: 'hash',
    });
    const registry = new ContestantRegistry(contestantsRepo, auditRepo, [
      new GeminiAdapter({ getApiKey: () => null }),
      ...createPlaceholderRosterAdapters(),
    ]);
    await registry.syncAll();

    const approvalsService = new ApprovalsService(approvalsRepo, usersRepo, auditRepo);
    const arenaService = new ArenaService(
      arenaRepo,
      contestantsRepo,
      approvalsService,
      auditRepo,
      manager,
      false,
    );

    const task = await arenaService.createTask(admin, {
      title: 'Fail Closed Policy Task',
      category: 'security',
      description: 'Verify fail-closed refusal for untrusted contestant tier.',
      instructions: 'Verify fail-closed refusal for untrusted contestant tier.',
      startingFiles: { 'ok.test.mjs': 'import test from "node:test"; test("ok", () => {});\n' },
      acceptanceChecks: [{ id: 'c1', label: 'ok', type: 'node_test', targetPath: 'ok.test.mjs' }],
      timeLimitMs: 2000,
      tokenBudget: 1000,
      costCapUsd: 0.1,
    });

    const staged = await arenaService.stageCompetition(admin, {
      title: 'Untrusted Execution Blocked Stage',
      taskId: task.id,
      contestantIds: ['gemini'],
      requestApproval: false,
      isTestFixture: true,
    });

    await assert.rejects(
      () =>
        arenaService.executeWithExecutors(
          admin,
          staged.competition.id,
          {
            gemini: async () => ({ tokensIn: 0, tokensOut: 0, estimatedCostUsd: 0 }),
          },
          { trustTier: 'untrusted_contestant' },
        ),
      (err: unknown) => err instanceof ArenaServiceError && err.statusCode === 403,
    );
  } finally {
    await db.close();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

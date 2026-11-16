import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runAllowlistedWorkspaceCommand,
  SandboxCommandError,
} from '../src/server/sandbox/commandRunner';
import {
  resolveSafeWorkspacePath,
  WorkspaceManager,
  WorkspaceSecurityError,
} from '../src/server/sandbox/workspaceManager';
import { runIndependentVerification } from '../src/server/verification/verifier';

function createTempSandboxDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('WorkspaceManager creates isolated workspaces and blocks traversal, absolute paths, and symlink escapes', () => {
  const sandboxRoot = createTempSandboxDir('arena-ws-');
  const outsideFile = path.join(sandboxRoot, 'host-secret.txt');
  fs.writeFileSync(outsideFile, 'HOST_SECRET_DO_NOT_READ', 'utf8');

  try {
    const manager = new WorkspaceManager(sandboxRoot);
    const startingFiles = {
      'src/math.mjs': 'export function add(a, b) { return a + b; }\n',
    };

    const entryA = manager.provisionEntryWorkspace('comp-1', 'entry-a', startingFiles);
    const entryB = manager.provisionEntryWorkspace('comp-1', 'entry-b', startingFiles);

    assert.notEqual(entryA.workspaceRoot, entryB.workspaceRoot);

    // Writing in entry A never leaks to entry B
    entryA.handle.writeFile('src/math.mjs', 'export function add(a, b) { return a * b; }\n');
    entryA.handle.writeFile('notes.txt', 'entry a note');
    assert.match(entryB.handle.readFile('src/math.mjs'), /a \+ b/);
    assert.equal(entryB.handle.listFiles().includes('notes.txt'), false);

    // Capture diff summary accurately
    const diffA = entryA.captureDiff();
    assert.deepEqual(diffA.created, ['notes.txt']);
    assert.deepEqual(diffA.modified, ['src/math.mjs']);
    assert.deepEqual(diffA.deleted, []);
    assert.equal(diffA.unchangedCount, 0);

    // Block path traversal, absolute paths, backslashes, and null bytes
    assert.throws(
      () => entryA.handle.readFile('../entry-b/src/math.mjs'),
      WorkspaceSecurityError,
    );
    assert.throws(
      () => entryA.handle.writeFile('../../outside.txt', 'pwn'),
      WorkspaceSecurityError,
    );
    assert.throws(
      () => resolveSafeWorkspacePath(entryA.workspaceRoot, '/etc/passwd'),
      WorkspaceSecurityError,
    );
    assert.throws(
      () => resolveSafeWorkspacePath(entryA.workspaceRoot, 'src\\math.mjs'),
      WorkspaceSecurityError,
    );
    assert.throws(
      () => resolveSafeWorkspacePath(entryA.workspaceRoot, 'file.txt\0.mjs'),
      WorkspaceSecurityError,
    );

    // Block symlink escape pointing outside workspaceRoot
    const symlinkPath = path.join(entryA.workspaceRoot, 'escape-link.txt');
    fs.symlinkSync(outsideFile, symlinkPath);
    assert.throws(
      () => entryA.handle.readFile('escape-link.txt'),
      WorkspaceSecurityError,
    );
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runAllowlistedWorkspaceCommand enforces allowlist, strips secrets, enforces timeout, and captures exit codes', async () => {
  const sandboxRoot = createTempSandboxDir('arena-cmd-');
  const prevSecret = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'AIzaTestSecretShouldNotLeak12345';

  try {
    const manager = new WorkspaceManager(sandboxRoot);
    const ws = manager.provisionEntryWorkspace('comp-cmd', 'entry-1', {
      'env.test.mjs': `
        import test from 'node:test';
        import assert from 'node:assert/strict';
        test('host secrets are stripped from sandbox env', () => {
          assert.equal(process.env.GEMINI_API_KEY, undefined);
        });
      `,
      'slow.test.mjs': `
        import test from 'node:test';
        test('hangs beyond timeout', async () => {
          await new Promise((r) => setTimeout(r, 3000));
        });
      `,
    });

    // Reject non-allowlisted command key
    await assert.rejects(
      () =>
        runAllowlistedWorkspaceCommand({
          workspaceRoot: ws.workspaceRoot,
          commandKey: 'bash' as unknown as 'node_test',
          targetPath: 'env.test.mjs',
          timeoutMs: 1000,
        }),
      SandboxCommandError,
    );

    // Pass allowlisted node_test and verify stripped env
    const okRun = await runAllowlistedWorkspaceCommand({
      workspaceRoot: ws.workspaceRoot,
      commandKey: 'node_test',
      targetPath: 'env.test.mjs',
      timeoutMs: 3000,
    });
    assert.equal(okRun.exitCode, 0);
    assert.equal(okRun.timedOut, false);

    // Enforce hard timeout
    const timedOutRun = await runAllowlistedWorkspaceCommand({
      workspaceRoot: ws.workspaceRoot,
      commandKey: 'node_test',
      targetPath: 'slow.test.mjs',
      timeoutMs: 200,
    });
    assert.equal(timedOutRun.timedOut, true);
    assert.equal(timedOutRun.exitCode, null);
  } finally {
    if (prevSecret === undefined) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY = prevSecret;
    }
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

test('runIndependentVerification executes real tests, assertions, and security scans and records evidence', async () => {
  const sandboxRoot = createTempSandboxDir('arena-ver-');
  try {
    const manager = new WorkspaceManager(sandboxRoot);

    // Passing workspace
    const passWs = manager.provisionEntryWorkspace('comp-v', 'pass-entry', {
      'solution.mjs': 'export function sum(a, b) { return a + b; }\n',
      'solution.test.mjs': `
        import test from 'node:test';
        import assert from 'node:assert/strict';
        import { sum } from './solution.mjs';
        test('adds positive numbers', () => assert.equal(sum(2, 3), 5));
        test('adds negative numbers', () => assert.equal(sum(-2, -3), -5));
      `,
    });

    const passReport = await runIndependentVerification({
      entryId: 'pass-entry',
      workspaceRoot: passWs.workspaceRoot,
      checks: [
        { id: 'c1', label: 'Unit tests', type: 'node_test', targetPath: 'solution.test.mjs' },
        { id: 'c2', label: 'Solution exists', type: 'file_exists', targetPath: 'solution.mjs' },
        { id: 'c3', label: 'Security scan', type: 'security_scan', targetPath: 'solution.mjs' },
      ],
      diffSummary: passWs.captureDiff(),
      timeLimitMs: 3000,
      entryTimedOut: false,
      entryErrored: false,
    });

    assert.equal(passReport.passed, true);
    assert.equal(passReport.exitCode, 0);
    assert.equal(passReport.testsTotal, 2);
    assert.equal(passReport.testsPassed, 2);
    assert.equal(passReport.testsFailed, 0);
    assert.match(passReport.evidenceHash, /^[a-f0-9]{64}$/);

    // Failing & insecure workspace
    const failWs = manager.provisionEntryWorkspace('comp-v', 'fail-entry', {
      'solution.mjs': 'export function sum(a, b) { return eval("a - b"); }\n',
      'solution.test.mjs': `
        import test from 'node:test';
        import assert from 'node:assert/strict';
        import { sum } from './solution.mjs';
        test('adds positive numbers', () => assert.equal(sum(2, 3), 5));
      `,
    });

    const failReport = await runIndependentVerification({
      entryId: 'fail-entry',
      workspaceRoot: failWs.workspaceRoot,
      checks: [
        { id: 'c1', label: 'Unit tests', type: 'node_test', targetPath: 'solution.test.mjs' },
        { id: 'c3', label: 'Security scan', type: 'security_scan', targetPath: 'solution.mjs' },
      ],
      diffSummary: failWs.captureDiff(),
      timeLimitMs: 3000,
      entryTimedOut: false,
      entryErrored: false,
    });

    assert.equal(failReport.passed, false);
    assert.equal(failReport.testsTotal, 1);
    assert.equal(failReport.testsFailed, 1);
    assert.equal(failReport.checks[0].passed, false);
    assert.equal(failReport.checks[1].passed, false);
    assert.match(failReport.checks[1].details, /eval_call/);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

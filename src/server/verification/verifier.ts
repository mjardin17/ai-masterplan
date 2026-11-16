import crypto from 'node:crypto';
import fs from 'node:fs';
import {
  AcceptanceCheckSpec,
  CheckExecutionOutcome,
  FileDiffSummary,
} from '../../shared/types';
import { ExecutionTrustTier } from '../sandbox/isolation';
import { runAllowlistedWorkspaceCommand } from '../sandbox/commandRunner';
import { resolveSafeWorkspacePath } from '../sandbox/workspaceManager';

export const INDEPENDENT_VERIFIER_ID = 'independent_verifier_v1';

export interface IndependentVerificationOutput {
  verifierId: string;
  passed: boolean;
  exitCode: number | null;
  testsPassed: number;
  testsFailed: number;
  testsTotal: number;
  checks: CheckExecutionOutcome[];
  stdoutExcerpt: string;
  stderrExcerpt: string;
  evidenceHash: string;
  executionTimeMs: number;
}

const SECURITY_FORBIDDEN_PATTERNS: { label: string; regex: RegExp }[] = [
  { label: 'eval_call', regex: /\beval\s*\(/ },
  { label: 'new_function', regex: /\bnew\s+Function\s*\(/ },
  { label: 'hardcoded_google_key', regex: /AIza[0-9A-Za-z_-]{20,}/ },
  { label: 'hardcoded_sk_key', regex: /sk-[0-9A-Za-z_-]{20,}/ },
  { label: 'child_process_exec', regex: /\bchild_process\b/ },
];

export function parseNodeTestTapSummary(stdout: string): {
  total: number;
  passed: number;
  failed: number;
} {
  const totalMatch = stdout.match(/^#\s*tests\s+(\d+)/m);
  const passMatch = stdout.match(/^#\s*pass\s+(\d+)/m);
  const failMatch = stdout.match(/^#\s*fail\s+(\d+)/m);

  const total = totalMatch ? Number.parseInt(totalMatch[1], 10) : 0;
  const passed = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
  const failed = failMatch ? Number.parseInt(failMatch[1], 10) : 0;

  return { total, passed, failed };
}

function truncateExcerpt(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]`;
}

export async function runIndependentVerification(input: {
  entryId: string;
  workspaceRoot: string;
  checks: AcceptanceCheckSpec[];
  diffSummary: FileDiffSummary;
  timeLimitMs: number;
  entryTimedOut: boolean;
  entryErrored: boolean;
  signal?: AbortSignal;
  trustTier?: ExecutionTrustTier;
}): Promise<IndependentVerificationOutput> {
  const startedAll = Date.now();
  const outcomes: CheckExecutionOutcome[] = [];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  let lastExitCode: number | null = 0;
  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;

  if (input.entryTimedOut || input.entryErrored) {
    outcomes.push({
      checkId: 'execution-prerequisite',
      label: 'Contestant execution completed within budget',
      type: 'file_exists',
      passed: false,
      exitCode: input.entryTimedOut ? null : 1,
      durationMs: 0,
      details: input.entryTimedOut
        ? 'Entry execution timed out before verification.'
        : 'Entry execution terminated with error before verification.',
    });
    lastExitCode = input.entryTimedOut ? null : 1;
  } else {
    for (const check of input.checks) {
      const checkStart = Date.now();

      if (check.type === 'node_test') {
        const target = check.targetPath ?? '';
        try {
          resolveSafeWorkspacePath(input.workspaceRoot, target);
          const run = await runAllowlistedWorkspaceCommand({
            workspaceRoot: input.workspaceRoot,
            commandKey: 'node_test',
            targetPath: target,
            timeoutMs: input.timeLimitMs,
            signal: input.signal,
            trustTier: input.trustTier ?? 'trusted_local_test',
          });
          if (run.stdout) stdoutChunks.push(run.stdout);
          if (run.stderr) stderrChunks.push(run.stderr);

          const tap = parseNodeTestTapSummary(run.stdout);
          totalTests += tap.total;
          passedTests += tap.passed;
          failedTests += tap.failed;
          lastExitCode = run.exitCode;

          const passed = !run.timedOut && !run.aborted && run.exitCode === 0 && tap.failed === 0;
          outcomes.push({
            checkId: check.id,
            label: check.label,
            type: check.type,
            passed,
            exitCode: run.exitCode,
            durationMs: run.durationMs,
            details: run.timedOut
              ? `Verification test timed out after ${input.timeLimitMs}ms.`
              : `exit=${run.exitCode}, tests=${tap.total}, pass=${tap.passed}, fail=${tap.failed}`,
          });
        } catch (err) {
          lastExitCode = 1;
          outcomes.push({
            checkId: check.id,
            label: check.label,
            type: check.type,
            passed: false,
            exitCode: 1,
            durationMs: Date.now() - checkStart,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (check.type === 'file_exists') {
        const target = check.targetPath ?? '';
        try {
          const resolved = resolveSafeWorkspacePath(input.workspaceRoot, target);
          const exists = fs.existsSync(resolved) && fs.statSync(resolved).isFile();
          outcomes.push({
            checkId: check.id,
            label: check.label,
            type: check.type,
            passed: exists,
            exitCode: exists ? 0 : 1,
            durationMs: Date.now() - checkStart,
            details: exists ? `Verified file exists: ${target}` : `Missing expected file: ${target}`,
          });
          if (!exists) lastExitCode = 1;
        } catch (err) {
          lastExitCode = 1;
          outcomes.push({
            checkId: check.id,
            label: check.label,
            type: check.type,
            passed: false,
            exitCode: 1,
            durationMs: Date.now() - checkStart,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (check.type === 'text_contains' || check.type === 'text_not_contains') {
        const target = check.targetPath ?? '';
        const needle = check.needle;
        try {
          if (typeof needle !== 'string' || needle.length === 0) {
            lastExitCode = 1;
            outcomes.push({
              checkId: check.id,
              label: check.label,
              type: check.type,
              passed: false,
              exitCode: 1,
              durationMs: Date.now() - checkStart,
              details: `Acceptance check "${check.id}" requires a non-empty needle string.`,
            });
          } else {
            const resolved = resolveSafeWorkspacePath(input.workspaceRoot, target);
            if (!fs.existsSync(resolved)) {
              lastExitCode = 1;
              outcomes.push({
                checkId: check.id,
                label: check.label,
                type: check.type,
                passed: false,
                exitCode: 1,
                durationMs: Date.now() - checkStart,
                details: `Target file missing: ${target}`,
              });
            } else {
              const content = fs.readFileSync(resolved, 'utf8');
              const found = content.includes(needle);
              const passed = check.type === 'text_contains' ? found : !found;
              if (!passed) lastExitCode = 1;
              outcomes.push({
                checkId: check.id,
                label: check.label,
                type: check.type,
                passed,
                exitCode: passed ? 0 : 1,
                durationMs: Date.now() - checkStart,
                details: passed
                  ? `Assertion satisfied on ${target}`
                  : `Assertion failed on ${target} for pattern "${needle}"`,
              });
            }
          }
        } catch (err) {
          lastExitCode = 1;
          outcomes.push({
            checkId: check.id,
            label: check.label,
            type: check.type,
            passed: false,
            exitCode: 1,
            durationMs: Date.now() - checkStart,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      } else if (check.type === 'security_scan') {
        const target = check.targetPath ?? '';
        try {
          const resolved = resolveSafeWorkspacePath(input.workspaceRoot, target);
          if (!fs.existsSync(resolved)) {
            lastExitCode = 1;
            outcomes.push({
              checkId: check.id,
              label: check.label,
              type: check.type,
              passed: false,
              exitCode: 1,
              durationMs: Date.now() - checkStart,
              details: `Target file missing for security scan: ${target}`,
            });
          } else {
            const content = fs.readFileSync(resolved, 'utf8');
            const findings = SECURITY_FORBIDDEN_PATTERNS.filter((p) => p.regex.test(content)).map(
              (p) => p.label,
            );
            const passed = findings.length === 0;
            if (!passed) lastExitCode = 1;
            outcomes.push({
              checkId: check.id,
              label: check.label,
              type: check.type,
              passed,
              exitCode: passed ? 0 : 1,
              durationMs: Date.now() - checkStart,
              details: passed
                ? `Security scan clean on ${target}`
                : `Security violations detected on ${target}: ${findings.join(', ')}`,
            });
          }
        } catch (err) {
          lastExitCode = 1;
          outcomes.push({
            checkId: check.id,
            label: check.label,
            type: check.type,
            passed: false,
            exitCode: 1,
            durationMs: Date.now() - checkStart,
            details: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  const allPassed = outcomes.length > 0 && outcomes.every((o) => o.passed);
  const stdoutExcerpt = truncateExcerpt(stdoutChunks.join('\n').trim());
  const stderrExcerpt = truncateExcerpt(stderrChunks.join('\n').trim());
  const executionTimeMs = Date.now() - startedAll;

  const evidenceHash = crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        entryId: input.entryId,
        verifierId: INDEPENDENT_VERIFIER_ID,
        passed: allPassed,
        exitCode: lastExitCode,
        testsPassed: passedTests,
        testsFailed: failedTests,
        testsTotal: totalTests,
        checks: outcomes,
        diffSummary: input.diffSummary,
        stdoutExcerpt,
        stderrExcerpt,
      }),
    )
    .digest('hex');

  return {
    verifierId: INDEPENDENT_VERIFIER_ID,
    passed: allPassed,
    exitCode: lastExitCode,
    testsPassed: passedTests,
    testsFailed: failedTests,
    testsTotal: totalTests,
    checks: outcomes,
    stdoutExcerpt,
    stderrExcerpt,
    evidenceHash,
    executionTimeMs,
  };
}

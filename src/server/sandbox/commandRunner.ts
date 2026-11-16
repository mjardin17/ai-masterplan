import { spawn } from 'node:child_process';
import { resolveSafeWorkspacePath } from './workspaceManager';

export type AllowlistedCommandKey = 'node_test';

export interface CommandRunResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxCommandError';
  }
}

/**
 * Executes strictly allowlisted verification commands inside an isolated workspace
 * with shell=false, stripped environment variables (no secrets), output caps, and hard timeouts.
 */
export async function runAllowlistedWorkspaceCommand(input: {
  workspaceRoot: string;
  commandKey: AllowlistedCommandKey;
  targetPath: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}): Promise<CommandRunResult> {
  if (input.commandKey !== 'node_test') {
    throw new SandboxCommandError(`Command key "${input.commandKey}" is not allowlisted.`);
  }

  // Validates targetPath is strictly inside workspaceRoot (throws WorkspaceSecurityError on escape)
  resolveSafeWorkspacePath(input.workspaceRoot, input.targetPath);

  const timeoutMs = Math.min(Math.max(input.timeoutMs, 100), 60_000);
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

  const args = ['--test', input.targetPath];
  const started = Date.now();

  return new Promise<CommandRunResult>((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: input.workspaceRoot,
      shell: false,
      env: {
        PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
        NODE_ENV: 'test',
        LANG: 'C.UTF-8',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdoutBuf = '';
    let stderrBuf = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore if already exited
      }
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxBytes) {
        const remaining = maxBytes - stdoutBytes;
        const slice = chunk.subarray(0, remaining);
        stdoutBuf += slice.toString('utf8');
        stdoutBytes += slice.length;
        if (chunk.length > remaining) {
          stdoutBuf += '\n[stdout truncated at ceiling]';
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxBytes) {
        const remaining = maxBytes - stderrBytes;
        const slice = chunk.subarray(0, remaining);
        stderrBuf += slice.toString('utf8');
        stderrBytes += slice.length;
        if (chunk.length > remaining) {
          stderrBuf += '\n[stderr truncated at ceiling]';
        }
      }
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: `${stderrBuf}\n${err.message}`.trim(),
      });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? null : code,
        timedOut,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: timedOut
          ? `${stderrBuf}\nExecution timed out after ${timeoutMs}ms.`.trim()
          : stderrBuf,
      });
    });
  });
}

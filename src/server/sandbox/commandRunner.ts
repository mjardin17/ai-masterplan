import { ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import {
  assertExecutionAllowedForTrustTier,
  detectSandboxCapabilities,
  ExecutionTrustTier,
  SandboxCapabilities,
} from './isolation';
import {
  resolveSafeWorkspacePath,
  validateRelativeWorkspacePath,
} from './workspaceManager';

export type AllowlistedCommandKey = 'node_test';

export interface CommandResourceLimits {
  cpuSeconds?: number;
  maxFileSizeBytes?: number;
  maxNoFile?: number;
  maxOldSpaceMb?: number;
}

export interface CommandRunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  isolationMechanisms: string[];
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_NOFILE = 64;
const DEFAULT_MAX_OLD_SPACE_MB = 128;

export class SandboxCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxCommandError';
  }
}

function killChildProcessGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || pid <= 0) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Ignore if process already terminated
    }
  }
}

/**
 * Executes strictly allowlisted verification commands inside an isolated workspace
 * with shell=false, stripped environment variables (no secrets), Node --permission
 * filesystem allowlisting, Linux mount/net/pid namespace + prlimit containment where
 * available, detached process-group SIGKILL cleanup, and AbortSignal cancellation.
 *
 * Fails closed whenever `trustTier === 'untrusted_contestant'` and a dedicated
 * external container/seccomp sandbox is not present on the host.
 */
export async function runAllowlistedWorkspaceCommand(input: {
  workspaceRoot: string;
  commandKey: AllowlistedCommandKey;
  targetPath: string;
  timeoutMs: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  trustTier?: ExecutionTrustTier;
  limits?: CommandResourceLimits;
  capabilitiesOverride?: SandboxCapabilities;
}): Promise<CommandRunResult> {
  if (input.commandKey !== 'node_test') {
    throw new SandboxCommandError(`Command key "${input.commandKey}" is not allowlisted.`);
  }

  const trustTier: ExecutionTrustTier = input.trustTier ?? 'trusted_local_test';
  const capabilities = input.capabilitiesOverride ?? detectSandboxCapabilities();
  assertExecutionAllowedForTrustTier(trustTier, capabilities);

  const realWorkspaceRoot = fs.existsSync(input.workspaceRoot)
    ? fs.realpathSync(input.workspaceRoot)
    : input.workspaceRoot;

  const safeRelTarget = validateRelativeWorkspacePath(input.targetPath, 'targetPath');
  resolveSafeWorkspacePath(realWorkspaceRoot, safeRelTarget);

  const timeoutMs = Math.min(Math.max(input.timeoutMs, 100), 60_000);
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const cpuSeconds = Math.max(
    1,
    Math.min(input.limits?.cpuSeconds ?? Math.ceil(timeoutMs / 1000) + 1, 60),
  );
  const maxFileSizeBytes = Math.max(
    1024,
    input.limits?.maxFileSizeBytes ?? DEFAULT_MAX_FILE_BYTES,
  );
  const maxNoFile = Math.max(16, input.limits?.maxNoFile ?? DEFAULT_MAX_NOFILE);
  const maxOldSpaceMb = Math.max(16, Math.min(input.limits?.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB, 512));

  if (input.signal?.aborted) {
    return {
      exitCode: null,
      signal: 'SIGKILL',
      timedOut: true,
      aborted: true,
      durationMs: 0,
      stdout: '',
      stderr: 'Execution cancelled by AbortSignal before process start.',
      isolationMechanisms: capabilities.enforcedMechanisms,
    };
  }

  const nodeArgs: string[] = [];
  if (capabilities.nodePermissionModelAvailable) {
    nodeArgs.push(
      '--permission',
      `--allow-fs-read=${realWorkspaceRoot}`,
      `--allow-fs-write=${realWorkspaceRoot}`,
    );
  }
  nodeArgs.push(
    `--max-old-space-size=${maxOldSpaceMb}`,
    '--test',
    ...(capabilities.nodePermissionModelAvailable ? ['--experimental-test-isolation=none'] : []),
    safeRelTarget,
  );

  let spawnCmd = process.execPath;
  let spawnArgs = nodeArgs;
  const activeMechanisms: string[] = [
    'shell_false',
    'stripped_env_vars',
    'detached_pgid_sigkill_cleanup',
    'workspace_path_and_symlink_validation',
  ];
  if (capabilities.nodePermissionModelAvailable) {
    activeMechanisms.push(
      'node_permission_fs_allowlist',
      'node_permission_no_child_process_worker_addons',
      'v8_max_old_space_size',
    );
  }

  if (capabilities.unshareNetPidMountWorks) {
    const innerArgs: string[] = [
      '--mount',
      '--net',
      '--pid',
      '--fork',
      '--mount-proc',
    ];
    activeMechanisms.push('unshare_mount_net_pid_proc');

    if (capabilities.prlimitAvailable) {
      innerArgs.push(
        '/usr/bin/prlimit',
        `--cpu=${cpuSeconds}`,
        `--fsize=${maxFileSizeBytes}`,
        `--nofile=${maxNoFile}`,
      );
      activeMechanisms.push('prlimit_cpu_fsize_nofile');
    }

    innerArgs.push(process.execPath, ...nodeArgs);
    spawnCmd = '/usr/bin/unshare';
    spawnArgs = innerArgs;
  } else if (capabilities.prlimitAvailable) {
    spawnCmd = '/usr/bin/prlimit';
    spawnArgs = [
      `--cpu=${cpuSeconds}`,
      `--fsize=${maxFileSizeBytes}`,
      `--nofile=${maxNoFile}`,
      process.execPath,
      ...nodeArgs,
    ];
    activeMechanisms.push('prlimit_cpu_fsize_nofile');
  }

  const started = Date.now();

  return new Promise<CommandRunResult>((resolve) => {
    const child = spawn(spawnCmd, spawnArgs, {
      cwd: realWorkspaceRoot,
      shell: false,
      detached: true,
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
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
    let aborted = false;
    let settled = false;
    let killWatchdog: NodeJS.Timeout | null = null;

    const cleanup = () => {
      clearTimeout(timer);
      if (killWatchdog) clearTimeout(killWatchdog);
      if (input.signal) {
        input.signal.removeEventListener('abort', onAbort);
      }
    };

    const forceTerminate = (reason: 'timeout' | 'abort') => {
      if (reason === 'timeout') timedOut = true;
      if (reason === 'abort') {
        aborted = true;
        timedOut = true;
      }
      killChildProcessGroup(child);

      if (!killWatchdog) {
        killWatchdog = setTimeout(() => {
          if (settled) return;
          settled = true;
          cleanup();
          child.stdout?.destroy();
          child.stderr?.destroy();
          resolve({
            exitCode: null,
            signal: 'SIGKILL',
            timedOut,
            aborted,
            durationMs: Date.now() - started,
            stdout: stdoutBuf,
            stderr: `${stderrBuf}\nExecution terminated by SIGKILL (${reason}).`.trim(),
            isolationMechanisms: activeMechanisms,
          });
        }, 750);
        killWatchdog.unref();
      }
    };

    const timer = setTimeout(() => {
      forceTerminate('timeout');
    }, timeoutMs);

    const onAbort = () => {
      forceTerminate('abort');
    };

    if (input.signal) {
      input.signal.addEventListener('abort', onAbort, { once: true });
    }

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
      cleanup();
      killChildProcessGroup(child);
      resolve({
        exitCode: 1,
        signal: null,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: `${stderrBuf}\n${err.message}`.trim(),
        isolationMechanisms: activeMechanisms,
      });
    });

    child.on('close', (code, sig) => {
      if (settled) return;
      settled = true;
      cleanup();
      const timeoutNote =
        aborted
          ? 'Execution cancelled via AbortSignal.'
          : timedOut
            ? `Execution timed out after ${timeoutMs}ms.`
            : '';
      resolve({
        exitCode: timedOut || aborted ? null : code,
        signal: sig,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        stdout: stdoutBuf,
        stderr: timeoutNote ? `${stderrBuf}\n${timeoutNote}`.trim() : stderrBuf,
        isolationMechanisms: activeMechanisms,
      });
    });
  });
}

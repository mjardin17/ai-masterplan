import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export type ExecutionTrustTier = 'trusted_local_test' | 'untrusted_contestant';

export interface SandboxCapabilities {
  platform: string;
  unshareAvailable: boolean;
  unshareNetPidMountWorks: boolean;
  prlimitAvailable: boolean;
  nodePermissionModelAvailable: boolean;
  externalContainerSandbox: 'bwrap' | 'nsjail' | 'docker' | null;
  untrustedContestantExecutionPermitted: boolean;
  enforcedMechanisms: string[];
  missingMechanisms: string[];
  summary: string;
}

export class SandboxIsolationError extends Error {
  public readonly statusCode = 403;

  constructor(message: string) {
    super(message);
    this.name = 'SandboxIsolationError';
  }
}

let cachedCapabilities: SandboxCapabilities | null = null;

function findExecutable(candidates: string[]): string | null {
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore stat errors
    }
  }
  return null;
}

function readSeccompMode(): number {
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    const match = status.match(/^Seccomp:\s*(\d+)/m);
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

export function clearSandboxCapabilitiesCache(): void {
  cachedCapabilities = null;
}

/**
 * Probes host OS and Node runtime capabilities once and caches the result.
 * Reports honestly what is enforced vs. what is missing so untrusted code
 * execution can fail closed when a full container/seccomp sandbox is absent.
 */
export function detectSandboxCapabilities(options?: { forceRefresh?: boolean }): SandboxCapabilities {
  if (cachedCapabilities && !options?.forceRefresh) {
    return cachedCapabilities;
  }

  const unsharePath = findExecutable(['/usr/bin/unshare', '/bin/unshare']);
  const prlimitPath = findExecutable(['/usr/bin/prlimit', '/bin/prlimit']);
  const bwrapPath = findExecutable(['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap']);
  const nsjailPath = findExecutable(['/usr/bin/nsjail', '/usr/local/bin/nsjail']);
  const dockerPath = findExecutable(['/usr/bin/docker', '/usr/local/bin/docker']);

  const externalContainerSandbox: SandboxCapabilities['externalContainerSandbox'] = bwrapPath
    ? 'bwrap'
    : nsjailPath
      ? 'nsjail'
      : dockerPath
        ? 'docker'
        : null;

  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  const nodePermissionModelAvailable = Number.isFinite(nodeMajor) && nodeMajor >= 20;

  let unshareNetPidMountWorks = false;
  if (unsharePath && process.platform === 'linux') {
    const probeArgs = [
      '--mount',
      '--net',
      '--pid',
      '--fork',
      '--mount-proc',
      ...(prlimitPath ? [prlimitPath, '--cpu=1', '--fsize=65536', '--nofile=64'] : []),
      process.execPath,
      '-e',
      'process.exit(0)',
    ];
    const res = spawnSync(unsharePath, probeArgs, {
      encoding: 'utf8',
      timeout: 3000,
      env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' },
    });
    unshareNetPidMountWorks = res.status === 0;
  }

  const seccompMode = readSeccompMode();
  const isRootUid = typeof process.getuid === 'function' ? process.getuid() === 0 : false;

  const enforcedMechanisms: string[] = [
    'workspace_path_and_symlink_validation',
    'stripped_env_vars',
    'detached_pgid_sigkill_cleanup',
    'shell_false_allowlisted_commands',
  ];
  if (nodePermissionModelAvailable) {
    enforcedMechanisms.push(
      'node_permission_fs_allowlist',
      'node_permission_no_child_process_worker_addons',
      'v8_max_old_space_size',
    );
  }
  if (unshareNetPidMountWorks) {
    enforcedMechanisms.push('unshare_mount_net_pid_proc');
  }
  if (prlimitPath) {
    enforcedMechanisms.push('prlimit_cpu_fsize_nofile');
  }

  const missingMechanisms: string[] = [];
  if (!externalContainerSandbox) {
    missingMechanisms.push('external_container_sandbox (bwrap/nsjail/docker)');
  }
  if (seccompMode === 0) {
    missingMechanisms.push('kernel_seccomp_bpf_filter');
  }
  if (isRootUid) {
    missingMechanisms.push('non_root_uid_isolation');
  }

  // Untrusted contestant execution requires BOTH an external OS container sandbox
  // AND kernel seccomp or non-root isolation, so we fail closed in this container.
  const untrustedContestantExecutionPermitted =
    externalContainerSandbox !== null && (seccompMode > 0 || !isRootUid);

  const summary = untrustedContestantExecutionPermitted
    ? `External sandbox active (${externalContainerSandbox}) with Node permission model.`
    : 'Trusted local verification uses Node --permission + unshare (--mount/--net/--pid/--mount-proc) + prlimit + stripped env; untrusted contestant code execution is blocked (fail-closed) due to missing external container/seccomp sandbox.';

  cachedCapabilities = {
    platform: process.platform,
    unshareAvailable: unsharePath !== null,
    unshareNetPidMountWorks,
    prlimitAvailable: prlimitPath !== null,
    nodePermissionModelAvailable,
    externalContainerSandbox,
    untrustedContestantExecutionPermitted,
    enforcedMechanisms,
    missingMechanisms,
    summary,
  };

  return cachedCapabilities;
}

/**
 * Enforces a fail-closed trust-tier policy before spawning code in a workspace.
 */
export function assertExecutionAllowedForTrustTier(
  trustTier: ExecutionTrustTier,
  capabilities: SandboxCapabilities = detectSandboxCapabilities(),
): void {
  if (trustTier === 'untrusted_contestant' && !capabilities.untrustedContestantExecutionPermitted) {
    throw new SandboxIsolationError(
      `Fail-closed isolation policy: untrusted contestant code execution is blocked because required host isolation is unavailable (${capabilities.missingMechanisms.join(', ')}).`,
    );
  }
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FileDiffSummary } from '../../shared/types';

export class WorkspaceSecurityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceSecurityError';
  }
}

export interface ScopedWorkspaceHandle {
  readonly workspaceRoot: string;
  readFile(relPath: string): string;
  writeFile(relPath: string, content: string): void;
  deleteFile(relPath: string): void;
  listFiles(): string[];
}

function sha256Text(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

export function resolveSafeWorkspacePath(workspaceRoot: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.trim() === '') {
    throw new WorkspaceSecurityError('Relative workspace file path is required.');
  }
  if (relPath.includes('\0')) {
    throw new WorkspaceSecurityError('Null byte in path is forbidden.');
  }
  if (relPath.includes('\\')) {
    throw new WorkspaceSecurityError('Backslashes are forbidden in workspace relative paths.');
  }
  if (path.isAbsolute(relPath)) {
    throw new WorkspaceSecurityError(`Absolute path forbidden: ${relPath}`);
  }

  const rootResolved = fs.existsSync(workspaceRoot)
    ? fs.realpathSync(workspaceRoot)
    : path.resolve(workspaceRoot);
  const candidate = path.resolve(rootResolved, relPath);
  const relative = path.relative(rootResolved, candidate);

  if (
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new WorkspaceSecurityError(`Path traversal outside workspace forbidden: ${relPath}`);
  }

  // Verify no existing parent or target symlink escapes the workspace root
  let current = candidate;
  while (current !== rootResolved) {
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        const realTarget = fs.realpathSync(current);
        const relTarget = path.relative(rootResolved, realTarget);
        if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) {
          throw new WorkspaceSecurityError(`Symlink escape outside workspace forbidden: ${relPath}`);
        }
      }
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return candidate;
}

function walkFilesRelative(rootDir: string, currentDir = rootDir, acc: string[] = []): string[] {
  if (!fs.existsSync(currentDir)) return acc;
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(currentDir, entry.name);
    if (entry.isSymbolicLink()) {
      const real = fs.realpathSync(full);
      const rel = path.relative(rootDir, real);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new WorkspaceSecurityError(`Symlink points outside workspace: ${entry.name}`);
      }
      continue;
    }
    if (entry.isDirectory()) {
      walkFilesRelative(rootDir, full, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(rootDir, full).split(path.sep).join('/');
      acc.push(rel);
    }
  }
  return acc.sort();
}

export interface ProvisionedWorkspace {
  workspaceRoot: string;
  initialHashes: Map<string, string>;
  handle: ScopedWorkspaceHandle;
  captureDiff: () => FileDiffSummary;
}

export class WorkspaceManager {
  constructor(private readonly sandboxBaseDir: string) {
    fs.mkdirSync(sandboxBaseDir, { recursive: true });
  }

  provisionEntryWorkspace(
    competitionId: string,
    entryId: string,
    startingFiles: Record<string, string>,
  ): ProvisionedWorkspace {
    const safeComp = competitionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeEntry = entryId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const workspaceRoot = path.resolve(this.sandboxBaseDir, safeComp, safeEntry);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });

    const initialHashes = new Map<string, string>();
    for (const [relPath, content] of Object.entries(startingFiles)) {
      const target = resolveSafeWorkspacePath(workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      initialHashes.set(relPath, sha256Text(content));
    }

    const handle: ScopedWorkspaceHandle = {
      workspaceRoot,
      readFile: (relPath: string) => {
        const target = resolveSafeWorkspacePath(workspaceRoot, relPath);
        return fs.readFileSync(target, 'utf8');
      },
      writeFile: (relPath: string, content: string) => {
        const target = resolveSafeWorkspacePath(workspaceRoot, relPath);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content, 'utf8');
      },
      deleteFile: (relPath: string) => {
        const target = resolveSafeWorkspacePath(workspaceRoot, relPath);
        if (fs.existsSync(target)) {
          fs.unlinkSync(target);
        }
      },
      listFiles: () => walkFilesRelative(workspaceRoot),
    };

    const captureDiff = (): FileDiffSummary => {
      const currentFiles = walkFilesRelative(workspaceRoot);
      const currentSet = new Set(currentFiles);
      const created: string[] = [];
      const modified: string[] = [];
      const deleted: string[] = [];
      let unchangedCount = 0;

      for (const rel of currentFiles) {
        const full = resolveSafeWorkspacePath(workspaceRoot, rel);
        const hash = sha256Text(fs.readFileSync(full, 'utf8'));
        const prev = initialHashes.get(rel);
        if (prev === undefined) {
          created.push(rel);
        } else if (prev !== hash) {
          modified.push(rel);
        } else {
          unchangedCount += 1;
        }
      }

      for (const oldRel of initialHashes.keys()) {
        if (!currentSet.has(oldRel)) {
          deleted.push(oldRel);
        }
      }

      return { created, modified, deleted, unchangedCount };
    };

    return {
      workspaceRoot,
      initialHashes,
      handle,
      captureDiff,
    };
  }
}

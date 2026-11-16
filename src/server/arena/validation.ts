import {
  AcceptanceCheckSpec,
  AcceptanceCheckType,
  ArenaCategory,
} from '../../shared/types';
import {
  validateRelativeWorkspacePath,
  WorkspaceSecurityError,
} from '../sandbox/workspaceManager';

export const VALID_ARENA_CATEGORIES: ArenaCategory[] = [
  'coding',
  'reasoning',
  'research',
  'debugging',
  'security',
  'recovery',
];

export const VALID_ACCEPTANCE_CHECK_TYPES: AcceptanceCheckType[] = [
  'node_test',
  'file_exists',
  'text_contains',
  'text_not_contains',
  'security_scan',
];

const MAX_STARTING_FILES = 100;
const MAX_STARTING_FILE_BYTES = 256 * 1024;
const MAX_ACCEPTANCE_CHECKS = 50;

export class TaskValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaskValidationError';
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ValidatedBenchmarkTaskInput {
  title: string;
  category: ArenaCategory;
  description: string;
  instructions: string;
  startingFiles: Record<string, string>;
  acceptanceChecks: AcceptanceCheckSpec[];
  timeLimitMs: number;
  tokenBudget: number;
  costCapUsd: number;
}

export function validateBenchmarkTaskInput(raw: unknown): ValidatedBenchmarkTaskInput {
  if (!isPlainRecord(raw)) {
    throw new TaskValidationError('Benchmark task payload must be a JSON object.');
  }

  if (typeof raw.title !== 'string' || raw.title.trim().length < 3 || raw.title.trim().length > 200) {
    throw new TaskValidationError('Task title must be a string between 3 and 200 characters.');
  }
  const title = raw.title.trim();

  if (
    typeof raw.category !== 'string' ||
    !VALID_ARENA_CATEGORIES.includes(raw.category as ArenaCategory)
  ) {
    throw new TaskValidationError(`Invalid category: ${String(raw.category ?? '')}`);
  }
  const category = raw.category as ArenaCategory;

  let description = title;
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') {
      throw new TaskValidationError('Task description must be a string.');
    }
    if (raw.description.trim().length > 2000) {
      throw new TaskValidationError('Task description must not exceed 2000 characters.');
    }
    description = raw.description.trim() || title;
  }

  if (typeof raw.instructions !== 'string' || raw.instructions.trim().length < 10) {
    throw new TaskValidationError('Task instructions must be a string of at least 10 characters.');
  }
  if (raw.instructions.length > 32_000) {
    throw new TaskValidationError('Task instructions must not exceed 32000 characters.');
  }
  const instructions = raw.instructions.trim();

  if (!isPlainRecord(raw.startingFiles)) {
    throw new TaskValidationError(
      'startingFiles must be a JSON object mapping relative file paths to string contents.',
    );
  }
  const startingEntries = Object.entries(raw.startingFiles);
  if (startingEntries.length > MAX_STARTING_FILES) {
    throw new TaskValidationError(`startingFiles cannot exceed ${MAX_STARTING_FILES} files.`);
  }
  const startingFiles: Record<string, string> = {};
  for (const [filePath, content] of startingEntries) {
    let safePath: string;
    try {
      safePath = validateRelativeWorkspacePath(filePath, 'startingFiles path');
    } catch (err) {
      throw new TaskValidationError(
        err instanceof WorkspaceSecurityError ? err.message : `Invalid startingFiles path: ${filePath}`,
      );
    }
    if (typeof content !== 'string') {
      throw new TaskValidationError(
        `startingFiles["${safePath}"] content must be a string.`,
      );
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_STARTING_FILE_BYTES) {
      throw new TaskValidationError(
        `startingFiles["${safePath}"] exceeds maximum size of ${MAX_STARTING_FILE_BYTES} bytes.`,
      );
    }
    startingFiles[safePath] = content;
  }

  if (!Array.isArray(raw.acceptanceChecks) || raw.acceptanceChecks.length === 0) {
    throw new TaskValidationError('At least one independent acceptance check is required.');
  }
  if (raw.acceptanceChecks.length > MAX_ACCEPTANCE_CHECKS) {
    throw new TaskValidationError(
      `acceptanceChecks cannot exceed ${MAX_ACCEPTANCE_CHECKS} entries.`,
    );
  }

  const seenCheckIds = new Set<string>();
  const acceptanceChecks: AcceptanceCheckSpec[] = raw.acceptanceChecks.map((item, idx) => {
    if (!isPlainRecord(item)) {
      throw new TaskValidationError(`acceptanceChecks[${idx}] must be an object.`);
    }
    if (typeof item.id !== 'string' || item.id.trim().length === 0 || item.id.trim().length > 80) {
      throw new TaskValidationError(
        `acceptanceChecks[${idx}].id must be a non-empty string up to 80 characters.`,
      );
    }
    const id = item.id.trim();
    if (seenCheckIds.has(id)) {
      throw new TaskValidationError(`Duplicate acceptance check id: "${id}".`);
    }
    seenCheckIds.add(id);

    if (
      typeof item.label !== 'string' ||
      item.label.trim().length === 0 ||
      item.label.trim().length > 200
    ) {
      throw new TaskValidationError(
        `acceptanceChecks[${idx}].label must be a non-empty string up to 200 characters.`,
      );
    }
    const label = item.label.trim();

    if (
      typeof item.type !== 'string' ||
      !VALID_ACCEPTANCE_CHECK_TYPES.includes(item.type as AcceptanceCheckType)
    ) {
      throw new TaskValidationError(
        `acceptanceChecks[${idx}].type is invalid: "${String(item.type ?? '')}".`,
      );
    }
    const type = item.type as AcceptanceCheckType;

    let targetPath: string;
    try {
      targetPath = validateRelativeWorkspacePath(
        item.targetPath,
        `acceptanceChecks[${idx}].targetPath`,
      );
    } catch (err) {
      throw new TaskValidationError(
        err instanceof WorkspaceSecurityError
          ? err.message
          : `acceptanceChecks[${idx}].targetPath is invalid.`,
      );
    }

    let needle: string | undefined;
    if (type === 'text_contains' || type === 'text_not_contains') {
      if (typeof item.needle !== 'string' || item.needle.length === 0) {
        throw new TaskValidationError(
          `acceptanceChecks[${idx}].needle must be a non-empty string for ${type}.`,
        );
      }
      if (item.needle.length > 2000) {
        throw new TaskValidationError(
          `acceptanceChecks[${idx}].needle must not exceed 2000 characters.`,
        );
      }
      needle = item.needle;
    } else if (item.needle !== undefined) {
      if (typeof item.needle !== 'string') {
        throw new TaskValidationError(`acceptanceChecks[${idx}].needle must be a string if provided.`);
      }
      needle = item.needle;
    }

    return {
      id,
      label,
      type,
      targetPath,
      ...(needle !== undefined ? { needle } : {}),
    };
  });

  if (typeof raw.timeLimitMs !== 'number' || !Number.isFinite(raw.timeLimitMs)) {
    throw new TaskValidationError('timeLimitMs must be a finite number.');
  }
  if (raw.timeLimitMs < 500 || raw.timeLimitMs > 120_000) {
    throw new TaskValidationError('timeLimitMs must be between 500 and 120000.');
  }

  if (typeof raw.tokenBudget !== 'number' || !Number.isFinite(raw.tokenBudget)) {
    throw new TaskValidationError('tokenBudget must be a finite number.');
  }
  if (raw.tokenBudget < 100) {
    throw new TaskValidationError('tokenBudget must be at least 100.');
  }

  if (typeof raw.costCapUsd !== 'number' || !Number.isFinite(raw.costCapUsd)) {
    throw new TaskValidationError('costCapUsd must be a finite number.');
  }
  if (raw.costCapUsd < 0) {
    throw new TaskValidationError('costCapUsd must be non-negative.');
  }

  return {
    title,
    category,
    description,
    instructions,
    startingFiles,
    acceptanceChecks,
    timeLimitMs: Math.round(raw.timeLimitMs),
    tokenBudget: Math.round(raw.tokenBudget),
    costCapUsd: raw.costCapUsd,
  };
}

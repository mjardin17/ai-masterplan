import crypto from 'node:crypto';
import path from 'node:path';

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  dbDriver: 'sqlite';
  sqlitePath: string;
  sandboxRoot: string;
  sessionSecret: string;
  sessionTtlHours: number;
  bootstrapAdminEmail: string | null;
  bootstrapAdminPassword: string | null;
  bootstrapAdminName: string;
  geminiApiKey: string | null;
  appUrl: string | null;
}

let ephemeralSessionSecret: string | null = null;

export function getServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number.parseInt(env.PORT || '3000', 10) || 3000;
  const nodeEnv = env.NODE_ENV || 'development';
  const rawSqlitePath = env.SQLITE_PATH?.trim();
  const sqlitePath =
    rawSqlitePath === ':memory:'
      ? ':memory:'
      : rawSqlitePath
        ? path.resolve(rawSqlitePath)
        : path.resolve(process.cwd(), 'data', 'ai-masterplan.db');
  const sandboxRoot = env.SANDBOX_ROOT?.trim()
    ? path.resolve(env.SANDBOX_ROOT.trim())
    : path.resolve(process.cwd(), 'data', 'workspaces');

  let sessionSecret = env.SESSION_SECRET?.trim() || '';
  if (!sessionSecret) {
    if (!ephemeralSessionSecret) {
      ephemeralSessionSecret = crypto.randomBytes(32).toString('hex');
      if (nodeEnv !== 'test') {
        console.warn('[config] SESSION_SECRET not set; using ephemeral in-memory signing secret.');
      }
    }
    sessionSecret = ephemeralSessionSecret;
  }

  const rawTtl = Number.parseInt(env.SESSION_TTL_HOURS || '24', 10);
  const sessionTtlHours = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : 24;

  const bootstrapAdminEmail = env.BOOTSTRAP_ADMIN_EMAIL?.trim() || null;
  const bootstrapAdminPassword = env.BOOTSTRAP_ADMIN_PASSWORD || null;
  const bootstrapAdminName = env.BOOTSTRAP_ADMIN_NAME?.trim() || 'Primary Administrator';
  const geminiApiKey = env.GEMINI_API_KEY?.trim() || null;
  const appUrl = env.APP_URL?.trim() || null;

  return {
    port,
    nodeEnv,
    dbDriver: 'sqlite',
    sqlitePath,
    sandboxRoot,
    sessionSecret,
    sessionTtlHours,
    bootstrapAdminEmail,
    bootstrapAdminPassword,
    bootstrapAdminName,
    geminiApiKey,
    appUrl,
  };
}

const SENSITIVE_KEY_PATTERN = /(key|token|secret|password|authorization|cookie|credential)/i;
const SENSITIVE_VALUE_PREFIXES = ['AIza', 'sk-', 'ghp_', 'gho_', 'Bearer '];

export function redactSensitiveData(input: unknown): unknown {
  if (input === null || input === undefined) {
    return input;
  }
  if (typeof input === 'string') {
    for (const prefix of SENSITIVE_VALUE_PREFIXES) {
      if (input.startsWith(prefix)) {
        return '[REDACTED]';
      }
    }
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item));
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = redactSensitiveData(v);
      }
    }
    return out;
  }
  return input;
}

export function sanitizeErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'Unknown error');
  return raw
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/sk-[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/gh[po]_[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[0-9A-Za-z._-]+/gi, 'Bearer [REDACTED]');
}

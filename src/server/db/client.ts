import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type SqlParam = string | number | bigint | Uint8Array | null;

export interface ExecuteResult {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
}

export interface DatabaseClient {
  readonly driver: 'sqlite' | 'postgres';
  query<T extends object>(sql: string, params?: SqlParam[]): Promise<T[]>;
  queryOne<T extends object>(sql: string, params?: SqlParam[]): Promise<T | null>;
  execute(sql: string, params?: SqlParam[]): Promise<ExecuteResult>;
  execRaw(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Translates PostgreSQL-style numbered placeholders ($1, $2, ...) into SQLite
 * positional `?` placeholders while preserving literal single-quoted strings
 * and correctly expanding repeated parameter references.
 */
export function translatePgPlaceholdersToSqlite(
  sql: string,
  params: SqlParam[] = [],
): { sql: string; params: SqlParam[] } {
  const mappedParams: SqlParam[] = [];
  let result = '';
  let i = 0;
  let inSingleQuote = false;

  while (i < sql.length) {
    const ch = sql[i];

    if (ch === "'") {
      result += ch;
      if (inSingleQuote && sql[i + 1] === "'") {
        result += "'";
        i += 2;
        continue;
      }
      inSingleQuote = !inSingleQuote;
      i += 1;
      continue;
    }

    if (!inSingleQuote && ch === '$') {
      let j = i + 1;
      while (j < sql.length && sql[j] >= '0' && sql[j] <= '9') {
        j += 1;
      }
      if (j > i + 1) {
        const index = Number.parseInt(sql.slice(i + 1, j), 10);
        if (index < 1 || index > params.length) {
          throw new Error(`SQL parameter $${index} out of bounds (provided ${params.length})`);
        }
        mappedParams.push(params[index - 1]);
        result += '?';
        i = j;
        continue;
      }
    }

    result += ch;
    i += 1;
  }

  return { sql: result, params: mappedParams };
}

export class SqliteDatabaseClient implements DatabaseClient {
  public readonly driver = 'sqlite' as const;
  private readonly db: DatabaseSync;
  private closed = false;
  private inTransaction = false;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
  }

  async query<T extends object>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<T[]> {
    const translated = translatePgPlaceholdersToSqlite(sql, params);
    const stmt = this.db.prepare(translated.sql);
    const rows = stmt.all(...translated.params) as T[];
    return rows;
  }

  async queryOne<T extends object>(
    sql: string,
    params: SqlParam[] = [],
  ): Promise<T | null> {
    const translated = translatePgPlaceholdersToSqlite(sql, params);
    const stmt = this.db.prepare(translated.sql);
    const row = stmt.get(...translated.params) as T | undefined;
    return row ?? null;
  }

  async execute(sql: string, params: SqlParam[] = []): Promise<ExecuteResult> {
    const translated = translatePgPlaceholdersToSqlite(sql, params);
    const stmt = this.db.prepare(translated.sql);
    const info = stmt.run(...translated.params);
    return {
      changes: info.changes,
      lastInsertRowid: info.lastInsertRowid,
    };
  }

  async execRaw(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async transaction<T>(fn: (tx: DatabaseClient) => Promise<T>): Promise<T> {
    if (this.inTransaction) {
      return fn(this);
    }
    this.inTransaction = true;
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const res = await fn(this);
      this.db.exec('COMMIT;');
      return res;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Ignore rollback errors if connection already rolled back
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.db.close();
    }
  }
}

export function createSqliteClient(dbPath: string): DatabaseClient {
  return new SqliteDatabaseClient(dbPath);
}

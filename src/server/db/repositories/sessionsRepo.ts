import crypto from 'node:crypto';
import { DatabaseClient } from '../client';

export interface SessionRecord {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}

export class SessionsRepository {
  constructor(private readonly db: DatabaseClient) {}

  async create(input: {
    userId: string;
    tokenHash: string;
    expiresAt: string;
  }): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await this.db.execute(
      `INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, revoked_at)
       VALUES ($1, $2, $3, $4, $5, NULL)`,
      [id, input.userId, input.tokenHash, input.expiresAt, now],
    );
    const created = await this.db.queryOne<SessionRecord>(
      'SELECT id, user_id, token_hash, expires_at, created_at, revoked_at FROM sessions WHERE id = $1',
      [id],
    );
    if (!created) {
      throw new Error('Failed to create session');
    }
    return created;
  }

  async findValidByTokenHash(tokenHash: string, nowIso: string): Promise<SessionRecord | null> {
    return this.db.queryOne<SessionRecord>(
      `SELECT id, user_id, token_hash, expires_at, created_at, revoked_at
       FROM sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, nowIso],
    );
  }

  async revokeByTokenHash(tokenHash: string): Promise<void> {
    await this.db.execute(
      'UPDATE sessions SET revoked_at = $1 WHERE token_hash = $2 AND revoked_at IS NULL',
      [new Date().toISOString(), tokenHash],
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.execute(
      'UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND revoked_at IS NULL',
      [new Date().toISOString(), userId],
    );
  }
}

import crypto from 'node:crypto';
import { PublicUser, UserRole } from '../../../shared/types';
import { DatabaseClient } from '../client';

export interface UserRecord {
  id: string;
  email: string;
  display_name: string;
  role: UserRole;
  password_hash: string;
  is_active: number;
  created_at: string;
  updated_at: string;
}

export function toPublicUser(row: UserRecord): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class UsersRepository {
  constructor(private readonly db: DatabaseClient) {}

  async countUsers(): Promise<number> {
    const row = await this.db.queryOne<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM users');
    return Number(row?.cnt ?? 0);
  }

  async countActiveByRoles(roles: UserRole[]): Promise<number> {
    if (roles.length === 0) return 0;
    const placeholders = roles.map((_, idx) => `$${idx + 1}`).join(', ');
    const row = await this.db.queryOne<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM users WHERE is_active = 1 AND role IN (${placeholders})`,
      roles,
    );
    return Number(row?.cnt ?? 0);
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    return this.db.queryOne<UserRecord>(
      'SELECT id, email, display_name, role, password_hash, is_active, created_at, updated_at FROM users WHERE email = $1',
      [normalized],
    );
  }

  async findById(id: string): Promise<UserRecord | null> {
    return this.db.queryOne<UserRecord>(
      'SELECT id, email, display_name, role, password_hash, is_active, created_at, updated_at FROM users WHERE id = $1',
      [id],
    );
  }

  async listAll(): Promise<PublicUser[]> {
    const rows = await this.db.query<UserRecord>(
      'SELECT id, email, display_name, role, password_hash, is_active, created_at, updated_at FROM users ORDER BY created_at ASC',
    );
    return rows.map(toPublicUser);
  }

  async create(input: {
    email: string;
    displayName: string;
    role: UserRole;
    passwordHash: string;
  }): Promise<PublicUser> {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const normalizedEmail = input.email.trim().toLowerCase();
    await this.db.execute(
      `INSERT INTO users (id, email, display_name, role, password_hash, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 1, $6, $7)`,
      [id, normalizedEmail, input.displayName.trim(), input.role, input.passwordHash, now, now],
    );
    const created = await this.findById(id);
    if (!created) {
      throw new Error('Failed to load created user');
    }
    return toPublicUser(created);
  }

  async updateRoleAndStatus(
    id: string,
    updates: { role?: UserRole; isActive?: boolean },
  ): Promise<PublicUser | null> {
    const existing = await this.findById(id);
    if (!existing) return null;

    const nextRole = updates.role ?? existing.role;
    const nextActive = updates.isActive === undefined ? existing.is_active : updates.isActive ? 1 : 0;
    const now = new Date().toISOString();

    await this.db.execute(
      'UPDATE users SET role = $1, is_active = $2, updated_at = $3 WHERE id = $4',
      [nextRole, nextActive, now, id],
    );
    const updated = await this.findById(id);
    return updated ? toPublicUser(updated) : null;
  }
}

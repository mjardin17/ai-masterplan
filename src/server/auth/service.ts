import { PublicUser, UserRole } from '../../shared/types';
import { ServerConfig } from '../config/env';
import { AuditRepository } from '../db/repositories/auditRepo';
import { SessionsRepository } from '../db/repositories/sessionsRepo';
import { toPublicUser, UsersRepository } from '../db/repositories/usersRepo';
import {
  generateSessionToken,
  hashPassword,
  hashSessionToken,
  signCookieValue,
  verifyPassword,
  verifySignedCookieValue,
} from './crypto';

export const SESSION_COOKIE_NAME = 'ai_masterplan_session';

export class AuthError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

export function validateEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

export function validatePasswordStrength(password: string): string | null {
  if (typeof password !== 'string' || password.length < 10) {
    return 'Password must be at least 10 characters long.';
  }
  return null;
}

export async function bootstrapAdminFromEnvIfEmpty(
  usersRepo: UsersRepository,
  auditRepo: AuditRepository,
  config: ServerConfig,
): Promise<PublicUser | null> {
  const count = await usersRepo.countUsers();
  if (count > 0) return null;

  if (!config.bootstrapAdminEmail || !config.bootstrapAdminPassword) {
    return null;
  }

  if (!validateEmail(config.bootstrapAdminEmail)) {
    throw new Error('BOOTSTRAP_ADMIN_EMAIL is not a valid email address.');
  }
  const pwErr = validatePasswordStrength(config.bootstrapAdminPassword);
  if (pwErr) {
    throw new Error(`BOOTSTRAP_ADMIN_PASSWORD invalid: ${pwErr}`);
  }

  const admin = await usersRepo.create({
    email: config.bootstrapAdminEmail,
    displayName: config.bootstrapAdminName,
    role: 'admin',
    passwordHash: hashPassword(config.bootstrapAdminPassword),
  });

  await auditRepo.append({
    actorType: 'system',
    actorId: 'bootstrap',
    actorRole: 'system',
    action: 'auth.bootstrap.env',
    resourceType: 'user',
    resourceId: admin.id,
    metadata: { email: admin.email, role: admin.role },
  });

  return admin;
}

export class AuthService {
  constructor(
    private readonly usersRepo: UsersRepository,
    private readonly sessionsRepo: SessionsRepository,
    private readonly auditRepo: AuditRepository,
    private readonly config: ServerConfig,
  ) {}

  async getStatus(rawCookieValue: string | undefined): Promise<{
    initialized: boolean;
    bootstrapAvailable: boolean;
    user: PublicUser | null;
  }> {
    const userCount = await this.usersRepo.countUsers();
    const initialized = userCount > 0;
    const user = await this.authenticateCookie(rawCookieValue);
    return {
      initialized,
      bootstrapAvailable: !initialized,
      user,
    };
  }

  async bootstrapInitialAdmin(input: {
    email: string;
    displayName: string;
    password: string;
  }): Promise<{ user: PublicUser; signedCookie: string; expiresAt: string }> {
    const existingCount = await this.usersRepo.countUsers();
    if (existingCount > 0) {
      throw new AuthError(409, 'System is already initialized; bootstrap is locked.');
    }
    if (!validateEmail(input.email)) {
      throw new AuthError(400, 'Valid administrator email is required.');
    }
    if (!input.displayName || input.displayName.trim().length < 2) {
      throw new AuthError(400, 'Display name must be at least 2 characters.');
    }
    const pwErr = validatePasswordStrength(input.password);
    if (pwErr) {
      throw new AuthError(400, pwErr);
    }

    const user = await this.usersRepo.create({
      email: input.email,
      displayName: input.displayName,
      role: 'admin',
      passwordHash: hashPassword(input.password),
    });

    await this.auditRepo.append({
      actorType: 'user',
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.bootstrap.interactive',
      resourceType: 'user',
      resourceId: user.id,
      metadata: { email: user.email, role: user.role },
    });

    const session = await this.issueSession(user.id);
    return { user, ...session };
  }

  async login(
    email: string,
    password: string,
    ipAddress?: string,
  ): Promise<{ user: PublicUser; signedCookie: string; expiresAt: string }> {
    const normalized = (email || '').trim().toLowerCase();
    const record = await this.usersRepo.findByEmail(normalized);

    if (!record || record.is_active !== 1 || !verifyPassword(password || '', record.password_hash)) {
      await this.auditRepo.append({
        actorType: 'system',
        actorId: normalized || 'anonymous',
        actorRole: null,
        action: 'auth.login.failed',
        resourceType: 'session',
        resourceId: normalized || 'anonymous',
        metadata: { reason: !record ? 'unknown_user' : record.is_active !== 1 ? 'inactive' : 'invalid_password', ipAddress: ipAddress ?? 'unknown' },
      });
      throw new AuthError(401, 'Invalid email or password.');
    }

    const user = toPublicUser(record);
    const session = await this.issueSession(user.id);

    await this.auditRepo.append({
      actorType: 'user',
      actorId: user.id,
      actorRole: user.role,
      action: 'auth.login.success',
      resourceType: 'session',
      resourceId: user.id,
      metadata: { email: user.email, ipAddress: ipAddress ?? 'unknown' },
    });

    return { user, ...session };
  }

  async logout(rawCookieValue: string | undefined, user: PublicUser | null): Promise<void> {
    if (rawCookieValue) {
      const token = verifySignedCookieValue(rawCookieValue, this.config.sessionSecret);
      if (token) {
        await this.sessionsRepo.revokeByTokenHash(hashSessionToken(token));
      }
    }
    if (user) {
      await this.auditRepo.append({
        actorType: 'user',
        actorId: user.id,
        actorRole: user.role,
        action: 'auth.logout',
        resourceType: 'session',
        resourceId: user.id,
        metadata: { email: user.email },
      });
    }
  }

  async authenticateCookie(rawCookieValue: string | undefined): Promise<PublicUser | null> {
    if (!rawCookieValue) return null;
    const token = verifySignedCookieValue(rawCookieValue, this.config.sessionSecret);
    if (!token) return null;

    const session = await this.sessionsRepo.findValidByTokenHash(
      hashSessionToken(token),
      new Date().toISOString(),
    );
    if (!session) return null;

    const userRecord = await this.usersRepo.findById(session.user_id);
    if (!userRecord || userRecord.is_active !== 1) return null;

    return toPublicUser(userRecord);
  }

  private async issueSession(userId: string): Promise<{ signedCookie: string; expiresAt: string }> {
    const token = generateSessionToken();
    const expiresAt = new Date(
      Date.now() + this.config.sessionTtlHours * 60 * 60 * 1000,
    ).toISOString();

    await this.sessionsRepo.create({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt,
    });

    return {
      signedCookie: signCookieValue(token, this.config.sessionSecret),
      expiresAt,
    };
  }
}

export function canRoleAccess(userRole: UserRole, allowed: UserRole[]): boolean {
  return allowed.includes(userRole);
}

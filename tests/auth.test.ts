import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hashPassword,
  hashSessionToken,
  parseCookies,
  signCookieValue,
  verifyPassword,
  verifySignedCookieValue,
} from '../src/server/auth/crypto';
import { AuthError, AuthService, bootstrapAdminFromEnvIfEmpty, canRoleAccess } from '../src/server/auth/service';
import { getServerConfig } from '../src/server/config/env';
import { createSqliteClient } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrations/001_initial_schema';
import { AuditRepository } from '../src/server/db/repositories/auditRepo';
import { SessionsRepository } from '../src/server/db/repositories/sessionsRepo';
import { UsersRepository } from '../src/server/db/repositories/usersRepo';

test('password scrypt hashing, verification, and signed cookies work securely', () => {
  const hash = hashPassword('Masterplan#2026!');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('Masterplan#2026!', hash), true);
  assert.equal(verifyPassword('wrong-password', hash), false);
  assert.equal(verifyPassword('Masterplan#2026!', 'malformed'), false);

  const secret = 'test-signing-secret-32-chars-minimum';
  const signed = signCookieValue('tok_abc123', secret);
  assert.equal(verifySignedCookieValue(signed, secret), 'tok_abc123');
  assert.equal(verifySignedCookieValue(signed, 'wrong-secret'), null);
  assert.equal(verifySignedCookieValue(`${signed}x`, secret), null);

  const cookies = parseCookies(`foo=bar; ai_masterplan_session=${encodeURIComponent(signed)}`);
  assert.equal(cookies.foo, 'bar');
  assert.equal(cookies.ai_masterplan_session, signed);
  assert.notEqual(hashSessionToken('tok_abc123'), 'tok_abc123');
});

test('bootstrap admin locks after first creation and login/logout enforces session lifecycle', async () => {
  const db = createSqliteClient(':memory:');
  try {
    await runMigrations(db);
    const config = getServerConfig({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SESSION_SECRET: 'unit-test-secret',
    });
    const usersRepo = new UsersRepository(db);
    const sessionsRepo = new SessionsRepository(db);
    const auditRepo = new AuditRepository(db);
    const authService = new AuthService(usersRepo, sessionsRepo, auditRepo, config);

    const statusBefore = await authService.getStatus(undefined);
    assert.equal(statusBefore.initialized, false);
    assert.equal(statusBefore.bootstrapAvailable, true);

    const boot = await authService.bootstrapInitialAdmin({
      email: 'root@masterplan.local',
      displayName: 'Root Admin',
      password: 'SecurePassword#2026',
    });
    assert.equal(boot.user.role, 'admin');

    await assert.rejects(
      () =>
        authService.bootstrapInitialAdmin({
          email: 'second@masterplan.local',
          displayName: 'Second',
          password: 'SecurePassword#2026',
        }),
      (err: unknown) => err instanceof AuthError && err.statusCode === 409,
    );

    const authed = await authService.authenticateCookie(boot.signedCookie);
    assert.equal(authed?.email, 'root@masterplan.local');

    await authService.logout(boot.signedCookie, authed);
    const afterLogout = await authService.authenticateCookie(boot.signedCookie);
    assert.equal(afterLogout, null);

    await assert.rejects(
      () => authService.login('root@masterplan.local', 'bad-password'),
      (err: unknown) => err instanceof AuthError && err.statusCode === 401,
    );

    const goodLogin = await authService.login('root@masterplan.local', 'SecurePassword#2026');
    assert.equal(goodLogin.user.email, 'root@masterplan.local');
  } finally {
    await db.close();
  }
});

test('env bootstrap creates initial admin once and RBAC helper enforces roles', async () => {
  const db = createSqliteClient(':memory:');
  try {
    await runMigrations(db);
    const config = getServerConfig({
      NODE_ENV: 'test',
      SQLITE_PATH: ':memory:',
      SESSION_SECRET: 'unit-test-secret',
      BOOTSTRAP_ADMIN_EMAIL: 'ops@masterplan.local',
      BOOTSTRAP_ADMIN_PASSWORD: 'EnvBootstrap#2026',
    });
    const usersRepo = new UsersRepository(db);
    const auditRepo = new AuditRepository(db);

    const first = await bootstrapAdminFromEnvIfEmpty(usersRepo, auditRepo, config);
    const second = await bootstrapAdminFromEnvIfEmpty(usersRepo, auditRepo, config);
    assert.equal(first?.email, 'ops@masterplan.local');
    assert.equal(second, null);

    assert.equal(canRoleAccess('admin', ['admin']), true);
    assert.equal(canRoleAccess('operator', ['admin', 'operator']), true);
    assert.equal(canRoleAccess('viewer', ['admin', 'reviewer']), false);
  } finally {
    await db.close();
  }
});

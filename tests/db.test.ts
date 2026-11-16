import assert from 'node:assert/strict';
import test from 'node:test';
import { createSqliteClient, translatePgPlaceholdersToSqlite } from '../src/server/db/client';
import { getLatestMigrationName, runMigrations } from '../src/server/db/migrations/001_initial_schema';
import { ApprovalsRepository } from '../src/server/db/repositories/approvalsRepo';
import { AuditRepository } from '../src/server/db/repositories/auditRepo';
import { ContestantsRepository } from '../src/server/db/repositories/contestantsRepo';
import { UsersRepository } from '../src/server/db/repositories/usersRepo';

test('translatePgPlaceholdersToSqlite converts $1..$N and ignores quoted strings', () => {
  const translated = translatePgPlaceholdersToSqlite(
    "SELECT * FROM users WHERE email = $1 AND note != '$2' AND role = $2 AND backup = $1",
    ['admin@example.com', 'admin'],
  );
  assert.equal(
    translated.sql,
    "SELECT * FROM users WHERE email = ? AND note != '$2' AND role = ? AND backup = ?",
  );
  assert.deepEqual(translated.params, ['admin@example.com', 'admin', 'admin@example.com']);
});

test('migrations are idempotent and audit_logs enforces append-only triggers', async () => {
  const db = createSqliteClient(':memory:');
  try {
    const first = await runMigrations(db);
    const second = await runMigrations(db);
    assert.equal(first, '001_initial_schema');
    assert.equal(second, '001_initial_schema');
    assert.equal(await getLatestMigrationName(db), '001_initial_schema');

    const auditRepo = new AuditRepository(db);
    const e1 = await auditRepo.append({
      actorType: 'system',
      actorId: 'system',
      action: 'system.boot',
      resourceType: 'system',
      resourceId: 'core',
      metadata: { apiKey: 'AIzaSyFakeSecret123456', safe: 'ok' },
    });
    assert.equal(e1.prevHash, 'GENESIS');
    assert.equal(e1.metadata.apiKey, '[REDACTED]');
    assert.equal(e1.metadata.safe, 'ok');

    const e2 = await auditRepo.append({
      actorType: 'system',
      actorId: 'system',
      action: 'system.check',
      resourceType: 'system',
      resourceId: 'core',
    });
    assert.equal(e2.prevHash, e1.entryHash);

    const chain = await auditRepo.verifyChain();
    assert.equal(chain.valid, true);
    assert.equal(chain.totalEntries, 2);

    await assert.rejects(
      () => db.execute('UPDATE audit_logs SET action = $1 WHERE seq = $2', ['tampered', e1.seq]),
      /append-only/i,
    );
    await assert.rejects(
      () => db.execute('DELETE FROM audit_logs WHERE seq = $1', [e1.seq]),
      /append-only/i,
    );
  } finally {
    await db.close();
  }
});

test('repositories persist users, contestants, and approvals cleanly', async () => {
  const db = createSqliteClient(':memory:');
  try {
    await runMigrations(db);
    const usersRepo = new UsersRepository(db);
    const contestantsRepo = new ContestantsRepository(db);
    const approvalsRepo = new ApprovalsRepository(db);

    const admin = await usersRepo.create({
      email: 'Admin@Masterplan.local',
      displayName: 'Lead Admin',
      role: 'admin',
      passwordHash: 'hash-placeholder',
    });
    assert.equal(admin.email, 'admin@masterplan.local');
    assert.equal(await usersRepo.countUsers(), 1);

    const contestant = await contestantsRepo.upsertDefinition({
      id: 'gemini',
      name: 'Google Gemini',
      kind: 'foundation_model',
      adapterType: 'api',
      provider: 'Google',
      capabilities: ['reasoning', 'coding'],
      status: 'unconfigured',
      statusReason: 'GEMINI_API_KEY not set.',
      lastCheckedAt: null,
    });
    assert.equal(contestant.status, 'unconfigured');

    const req = await approvalsRepo.create({
      actionType: 'adapter_activation',
      targetResource: 'gemini',
      summary: 'Enable Gemini live adapter',
      requestedByUserId: admin.id,
      payload: { token: 'sk-secret-value', tier: 'standard' },
    });
    assert.equal(req.status, 'pending');
    assert.equal(req.payload.token, '[REDACTED]');
    assert.equal(await approvalsRepo.countPending(), 1);
  } finally {
    await db.close();
  }
});

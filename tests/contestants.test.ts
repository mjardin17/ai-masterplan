import assert from 'node:assert/strict';
import test from 'node:test';
import { GeminiAdapter } from '../src/server/adapters/geminiAdapter';
import { ContestantRegistry } from '../src/server/adapters/registry';
import { createPlaceholderRosterAdapters } from '../src/server/adapters/unconfiguredAdapters';
import { createSqliteClient } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrations/001_initial_schema';
import { AuditRepository } from '../src/server/db/repositories/auditRepo';
import { ContestantsRepository } from '../src/server/db/repositories/contestantsRepo';
import { hashPassword } from '../src/server/auth/crypto';
import { UsersRepository } from '../src/server/db/repositories/usersRepo';

test('GeminiAdapter reports unconfigured without key, connected on valid probe, and sanitized error on failure', async () => {
  const missingKeyAdapter = new GeminiAdapter({ getApiKey: () => null });
  const unconfigured = await missingKeyAdapter.checkHealth();
  assert.equal(unconfigured.status, 'unconfigured');
  assert.match(unconfigured.statusReason, /GEMINI_API_KEY/);

  const workingAdapter = new GeminiAdapter({
    getApiKey: () => 'AIzaFakeTestKeyForUnitCheck',
    probeFactory: () => ({
      listModels: async () => ({ page: [{ name: 'models/gemini-4-hydrogen' }] }),
    }),
  });
  const connected = await workingAdapter.checkHealth();
  assert.equal(connected.status, 'connected');

  const failingAdapter = new GeminiAdapter({
    getApiKey: () => 'AIzaFakeSecret1234567890',
    probeFactory: () => ({
      listModels: async () => {
        throw new Error('403 PERMISSION_DENIED for key AIzaFakeSecret1234567890');
      },
    }),
  });
  const errored = await failingAdapter.checkHealth();
  assert.equal(errored.status, 'error');
  assert.equal(errored.statusReason.includes('AIzaFakeSecret1234567890'), false);
  assert.match(errored.statusReason, /\[REDACTED_KEY\]/);
});

test('ContestantRegistry syncs 8 honest contestants and handles disable/enable cleanly', async () => {
  const db = createSqliteClient(':memory:');
  try {
    await runMigrations(db);
    const contestantsRepo = new ContestantsRepository(db);
    const auditRepo = new AuditRepository(db);
    const usersRepo = new UsersRepository(db);

    const admin = await usersRepo.create({
      email: 'admin@test.local',
      displayName: 'Admin',
      role: 'admin',
      passwordHash: hashPassword('Password#1234'),
    });

    const gemini = new GeminiAdapter({ getApiKey: () => null });
    const registry = new ContestantRegistry(contestantsRepo, auditRepo, [
      gemini,
      ...createPlaceholderRosterAdapters(),
    ]);

    const list = await registry.syncAll();
    assert.equal(list.length, 8);
    assert.ok(list.every((c) => c.status === 'unconfigured'));

    const disabled = await registry.setEnabled('claude', false, admin);
    assert.equal(disabled?.status, 'disabled');
    assert.equal(disabled?.isEnabled, false);

    const reenabled = await registry.setEnabled('claude', true, admin);
    assert.equal(reenabled?.status, 'unconfigured');
    assert.equal(reenabled?.isEnabled, true);
  } finally {
    await db.close();
  }
});

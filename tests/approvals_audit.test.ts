import assert from 'node:assert/strict';
import test from 'node:test';
import { ApprovalServiceError, ApprovalsService } from '../src/server/approvals/service';
import { hashPassword } from '../src/server/auth/crypto';
import { createSqliteClient } from '../src/server/db/client';
import { runMigrations } from '../src/server/db/migrations/001_initial_schema';
import { ApprovalsRepository } from '../src/server/db/repositories/approvalsRepo';
import { AuditRepository } from '../src/server/db/repositories/auditRepo';
import { UsersRepository } from '../src/server/db/repositories/usersRepo';

test('approval workflow enforces roles, segregation of duties, and writes hash-chained audit records', async () => {
  const db = createSqliteClient(':memory:');
  try {
    await runMigrations(db);
    const usersRepo = new UsersRepository(db);
    const approvalsRepo = new ApprovalsRepository(db);
    const auditRepo = new AuditRepository(db);
    const service = new ApprovalsService(approvalsRepo, usersRepo, auditRepo);

    const operator = await usersRepo.create({
      email: 'operator@test.local',
      displayName: 'Operator',
      role: 'operator',
      passwordHash: hashPassword('Password#1234'),
    });
    const reviewer = await usersRepo.create({
      email: 'reviewer@test.local',
      displayName: 'Reviewer',
      role: 'reviewer',
      passwordHash: hashPassword('Password#1234'),
    });
    const admin = await usersRepo.create({
      email: 'admin@test.local',
      displayName: 'Admin',
      role: 'admin',
      passwordHash: hashPassword('Password#1234'),
    });

    const req1 = await service.createRequest(operator, {
      actionType: 'adapter_activation',
      targetResource: 'gemini',
      summary: 'Activate Gemini live probing',
      payload: { envVar: 'GEMINI_API_KEY' },
    });
    assert.equal(req1.status, 'pending');

    // Operator cannot decide approvals
    await assert.rejects(
      () =>
        service.decideRequest(operator, {
          id: req1.id,
          decision: 'approved',
          decisionNote: 'Trying self-approve',
        }),
      (err: unknown) => err instanceof ApprovalServiceError && err.statusCode === 403,
    );

    // Segregation of duties blocks self-decision when multiple reviewers/admins exist
    const reqByAdmin = await service.createRequest(admin, {
      actionType: 'spend_cap_change',
      targetResource: 'arena-budget',
      summary: 'Increase cap to $5/day',
    });
    await assert.rejects(
      () =>
        service.decideRequest(admin, {
          id: reqByAdmin.id,
          decision: 'approved',
          decisionNote: 'Self approval attempt',
        }),
      (err: unknown) => err instanceof ApprovalServiceError && err.statusCode === 403,
    );

    // Reviewer can approve operator request
    const approved = await service.decideRequest(reviewer, {
      id: req1.id,
      decision: 'approved',
      decisionNote: 'Verified key policy compliance.',
    });
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decidedByUserId, reviewer.id);

    // Double decision blocked with 409
    await assert.rejects(
      () =>
        service.decideRequest(admin, {
          id: req1.id,
          decision: 'rejected',
          decisionNote: 'Late reject',
        }),
      (err: unknown) => err instanceof ApprovalServiceError && err.statusCode === 409,
    );

    const chain = await auditRepo.verifyChain();
    assert.equal(chain.valid, true);
    assert.equal(chain.totalEntries, 3);
  } finally {
    await db.close();
  }
});

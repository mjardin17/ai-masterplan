import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { GeminiAdapter } from '../src/server/adapters/geminiAdapter';
import { createPlaceholderRosterAdapters } from '../src/server/adapters/unconfiguredAdapters';
import { createBackendApp } from '../src/server/app';
import { getServerConfig } from '../src/server/config/env';
import { ContestantsRepository } from '../src/server/db/repositories/contestantsRepo';

async function startArenaTestServer(sandboxRoot: string) {
  const config = getServerConfig({
    NODE_ENV: 'test',
    SQLITE_PATH: ':memory:',
    SESSION_SECRET: 'arena-api-test-secret-key',
    SANDBOX_ROOT: sandboxRoot,
  });

  const runtime = await createBackendApp({
    config,
    disableRateLimit: true,
    adapters: [
      new GeminiAdapter({ getApiKey: () => null }),
      ...createPlaceholderRosterAdapters(),
    ],
  });

  const server = http.createServer(runtime.app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind Arena test server');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    runtime,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
      await runtime.close();
    },
  };
}

function extractCookie(setCookieHeader: string | null): string {
  if (!setCookieHeader) return '';
  return setCookieHeader.split(';')[0] ?? '';
}

test('Arena HTTP API enforces RBAC, rejects unconfigured contestants, enforces approval gates, and blocks paid launches in M2', async () => {
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-api-'));
  const srv = await startArenaTestServer(sandboxRoot);

  try {
    // Unauthenticated rejected
    const unauth = await fetch(`${srv.baseUrl}/api/arena/tasks`);
    assert.equal(unauth.status, 401);

    // Bootstrap admin
    const bootRes = await fetch(`${srv.baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@arena.test',
        displayName: 'Arena Admin',
        password: 'StrongPassword#2026',
      }),
    });
    assert.equal(bootRes.status, 201);
    const adminCookie = extractCookie(bootRes.headers.get('set-cookie'));

    // Create viewer user and verify RBAC blocks viewer task creation (403)
    await fetch(`${srv.baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        email: 'viewer@arena.test',
        displayName: 'Arena Viewer',
        role: 'viewer',
        password: 'ViewerPassword#2026',
      }),
    });
    const viewerLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'viewer@arena.test',
        password: 'ViewerPassword#2026',
      }),
    });
    const viewerCookie = extractCookie(viewerLogin.headers.get('set-cookie'));

    const viewerCreateTask = await fetch(`${srv.baseUrl}/api/arena/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie },
      body: JSON.stringify({
        title: 'Unauthorized Task',
        category: 'coding',
        description: 'Blocked',
        instructions: 'Viewer cannot create benchmark tasks.',
        startingFiles: {},
        acceptanceChecks: [{ id: 'c1', label: 'check', type: 'file_exists', targetPath: 'a.txt' }],
        timeLimitMs: 2000,
        tokenBudget: 1000,
        costCapUsd: 0.1,
      }),
    });
    assert.equal(viewerCreateTask.status, 403);

    // Admin creates benchmark task
    const createTaskRes = await fetch(`${srv.baseUrl}/api/arena/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        title: 'String Normalization Benchmark',
        category: 'coding',
        description: 'Normalize whitespace and case.',
        instructions: 'Export normalizeText(input) in normalize.mjs.',
        startingFiles: { 'normalize.mjs': 'export function normalizeText(s) { return s; }\n' },
        acceptanceChecks: [
          { id: 'exists', label: 'File exists', type: 'file_exists', targetPath: 'normalize.mjs' },
        ],
        timeLimitMs: 3000,
        tokenBudget: 2500,
        costCapUsd: 0.2,
      }),
    });
    assert.equal(createTaskRes.status, 201);
    const taskBody = (await createTaskRes.json()) as any;
    assert.equal(taskBody.task.category, 'coding');

    // Staging with unconfigured contestant MUST be rejected (400)
    const badStageRes = await fetch(`${srv.baseUrl}/api/arena/competitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        title: 'Invalid Unconfigured Stage',
        taskId: taskBody.task.id,
        contestantIds: ['gemini'],
      }),
    });
    assert.equal(badStageRes.status, 400);

    // Simulate connected Gemini contestant in DB (no live paid run will occur)
    const contestantsRepo = new ContestantsRepository(srv.runtime.db);
    await contestantsRepo.updateHealth(
      'gemini',
      'connected',
      'API key present in test env',
      new Date().toISOString(),
    );

    // Stage competition -> creates awaiting_approval + linked approval request
    const stageRes = await fetch(`${srv.baseUrl}/api/arena/competitions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        title: 'Gemini Coding Benchmark #1',
        taskId: taskBody.task.id,
        contestantIds: ['gemini'],
      }),
    });
    assert.equal(stageRes.status, 201);
    const stageBody = (await stageRes.json()) as any;
    assert.equal(stageBody.competition.status, 'awaiting_approval');
    assert.ok(stageBody.competition.approvalRequestId);
    assert.equal(stageBody.entries.length, 1);

    // Launching before human approval MUST be blocked (403)
    const unapprovedLaunch = await fetch(
      `${srv.baseUrl}/api/arena/competitions/${stageBody.competition.id}/launch`,
      {
        method: 'POST',
        headers: { Cookie: adminCookie },
      },
    );
    assert.equal(unapprovedLaunch.status, 403);
    const unapprovedErr = (await unapprovedLaunch.json()) as any;
    assert.match(unapprovedErr.error, /Human approval is required/i);

    // Approve the linked competition_budget request
    const decideRes = await fetch(
      `${srv.baseUrl}/api/approvals/${stageBody.competition.approvalRequestId}/decide`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
        body: JSON.stringify({
          decision: 'approved',
          decisionNote: 'Budget approved for verification check.',
        }),
      },
    );
    assert.equal(decideRes.status, 200);

    // Launching after approval is STILL blocked by M2 paid-execution policy (403)
    const policyLaunch = await fetch(
      `${srv.baseUrl}/api/arena/competitions/${stageBody.competition.id}/launch`,
      {
        method: 'POST',
        headers: { Cookie: adminCookie },
      },
    );
    assert.equal(policyLaunch.status, 403);
    const policyErr = (await policyLaunch.json()) as any;
    assert.match(policyErr.error, /Paid AI model competitions are disabled in Milestone 2/i);

    // Leaderboard and observations remain clean & unfabricated
    const lbRes = await fetch(`${srv.baseUrl}/api/arena/leaderboard`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(lbRes.status, 200);
    const lbBody = (await lbRes.json()) as any;
    assert.deepEqual(lbBody.leaderboard, []);

    const obsRes = await fetch(`${srv.baseUrl}/api/arena/observations`, {
      headers: { Cookie: viewerCookie },
    });
    assert.equal(obsRes.status, 200);
    const obsBody = (await obsRes.json()) as any;
    assert.deepEqual(obsBody.observations, []);
  } finally {
    await srv.close();
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
});

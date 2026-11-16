import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { GeminiAdapter } from '../src/server/adapters/geminiAdapter';
import { createPlaceholderRosterAdapters } from '../src/server/adapters/unconfiguredAdapters';
import { createBackendApp } from '../src/server/app';
import { getServerConfig } from '../src/server/config/env';

async function startTestServer() {
  const config = getServerConfig({
    NODE_ENV: 'test',
    SQLITE_PATH: ':memory:',
    SESSION_SECRET: 'integration-test-secret-key',
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
    throw new Error('Failed to bind test HTTP server');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
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

test('full HTTP API integration: health, bootstrap, RBAC, contestants, approvals, and audit log', async () => {
  const srv = await startTestServer();
  try {
    // 1. Public health check
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const health = (await healthRes.json()) as any;
    assert.equal(health.status, 'ok');
    assert.equal(health.database.driver, 'sqlite');
    assert.equal(health.database.migrationVersion, '002_milestone2_arena');
    assert.equal(health.contestants.total, 8);
    assert.equal(health.contestants.unconfigured, 8);
    assert.equal(health.audit, undefined);

    // 2. Protected routes reject unauthenticated calls with 401
    const unauthContestants = await fetch(`${srv.baseUrl}/api/contestants`);
    assert.equal(unauthContestants.status, 401);

    // 3. Auth status reports bootstrap available
    const statusRes = await fetch(`${srv.baseUrl}/api/auth/status`);
    const statusBody = (await statusRes.json()) as any;
    assert.equal(statusBody.initialized, false);
    assert.equal(statusBody.bootstrapAvailable, true);

    // 4. Bootstrap initial admin
    const bootRes = await fetch(`${srv.baseUrl}/api/auth/bootstrap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@masterplan.test',
        displayName: 'Test Admin',
        password: 'StrongPassword#2026',
      }),
    });
    assert.equal(bootRes.status, 201);
    const adminCookie = extractCookie(bootRes.headers.get('set-cookie'));
    assert.ok(adminCookie.includes('ai_masterplan_session='));

    // 5. Authenticated health check exposes pending approvals and valid audit chain
    const authedHealth = await fetch(`${srv.baseUrl}/api/health`, {
      headers: { Cookie: adminCookie },
    }).then((r) => r.json() as Promise<any>);
    assert.equal(authedHealth.audit.valid, true);
    assert.equal(authedHealth.approvals.pending, 0);

    // 6. Create a viewer user and verify RBAC blocks viewer mutations with 403
    const createViewer = await fetch(`${srv.baseUrl}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        email: 'viewer@masterplan.test',
        displayName: 'Read Only Viewer',
        role: 'viewer',
        password: 'ViewerPassword#2026',
      }),
    });
    assert.equal(createViewer.status, 201);

    const viewerLogin = await fetch(`${srv.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'viewer@masterplan.test',
        password: 'ViewerPassword#2026',
      }),
    });
    assert.equal(viewerLogin.status, 200);
    const viewerCookie = extractCookie(viewerLogin.headers.get('set-cookie'));

    const viewerHealthCheck = await fetch(`${srv.baseUrl}/api/contestants/gemini/health-check`, {
      method: 'POST',
      headers: { Cookie: viewerCookie },
    });
    assert.equal(viewerHealthCheck.status, 403);

    // 7. Admin triggers health check on Gemini -> stays honestly unconfigured
    const hcRes = await fetch(`${srv.baseUrl}/api/contestants/gemini/health-check`, {
      method: 'POST',
      headers: { Cookie: adminCookie },
    });
    assert.equal(hcRes.status, 200);
    const hcBody = (await hcRes.json()) as any;
    assert.equal(hcBody.contestant.status, 'unconfigured');
    assert.ok(hcBody.contestant.lastCheckedAt);

    // 8. Admin submits an approval and decides it (single-admin mode since viewer cannot review)
    const reqRes = await fetch(`${srv.baseUrl}/api/approvals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        actionType: 'adapter_activation',
        targetResource: 'gemini',
        summary: 'Approve Gemini metadata check in M1',
      }),
    });
    assert.equal(reqRes.status, 201);
    const reqBody = (await reqRes.json()) as any;
    assert.equal(reqBody.approval.status, 'pending');

    const decideRes = await fetch(`${srv.baseUrl}/api/approvals/${reqBody.approval.id}/decide`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        decision: 'approved',
        decisionNote: 'Approved for M1 verification.',
      }),
    });
    assert.equal(decideRes.status, 200);
    const decideBody = (await decideRes.json()) as any;
    assert.equal(decideBody.approval.status, 'approved');

    // 9. Audit log verifies unbroken hash chain across all operations
    const auditRes = await fetch(`${srv.baseUrl}/api/audit-logs`, {
      headers: { Cookie: adminCookie },
    });
    assert.equal(auditRes.status, 200);
    const auditBody = (await auditRes.json()) as any;
    assert.equal(auditBody.verification.valid, true);
    assert.ok(auditBody.total >= 5);
  } finally {
    await srv.close();
  }
});

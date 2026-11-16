import express, { Express, NextFunction, Request, Response } from 'express';
import { ContestantRegistry } from './adapters/registry';
import { ContestantAdapter } from './adapters/types';
import { ApprovalsService } from './approvals/service';
import { ArenaService } from './arena/runner';
import { createAttachAuthMiddleware, requireSameOrigin } from './auth/middleware';
import { AuthService, bootstrapAdminFromEnvIfEmpty } from './auth/service';
import { getServerConfig, sanitizeErrorMessage, ServerConfig } from './config/env';
import { createSqliteClient, DatabaseClient } from './db/client';
import { runAllMigrations } from './db/migrations/002_milestone2_arena';
import { ApprovalsRepository } from './db/repositories/approvalsRepo';
import { ArenaRepository } from './db/repositories/arenaRepo';
import { AuditRepository } from './db/repositories/auditRepo';
import { ContestantsRepository } from './db/repositories/contestantsRepo';
import { SessionsRepository } from './db/repositories/sessionsRepo';
import { UsersRepository } from './db/repositories/usersRepo';
import { createApprovalsRouter } from './routes/approvals';
import { createArenaRouter } from './routes/arena';
import { createAuditRouter } from './routes/audit';
import { createAuthRouter } from './routes/auth';
import { createContestantsRouter } from './routes/contestants';
import { createHealthRouter } from './routes/health';
import { WorkspaceManager } from './sandbox/workspaceManager';

export interface AppRuntime {
  app: Express;
  db: DatabaseClient;
  config: ServerConfig;
  registry: ContestantRegistry;
  arenaService: ArenaService;
  close: () => Promise<void>;
}

export async function createBackendApp(options?: {
  config?: ServerConfig;
  adapters?: ContestantAdapter[];
  disableRateLimit?: boolean;
}): Promise<AppRuntime> {
  const config = options?.config ?? getServerConfig();
  const db = createSqliteClient(config.sqlitePath);
  const startedAtMs = Date.now();

  await runAllMigrations(db);

  const usersRepo = new UsersRepository(db);
  const sessionsRepo = new SessionsRepository(db);
  const contestantsRepo = new ContestantsRepository(db);
  const auditRepo = new AuditRepository(db);
  const approvalsRepo = new ApprovalsRepository(db);
  const arenaRepo = new ArenaRepository(db);

  await bootstrapAdminFromEnvIfEmpty(usersRepo, auditRepo, config);

  const registry = new ContestantRegistry(contestantsRepo, auditRepo, options?.adapters);
  await registry.syncAll();

  const authService = new AuthService(usersRepo, sessionsRepo, auditRepo, config);
  const approvalsService = new ApprovalsService(approvalsRepo, usersRepo, auditRepo);
  const workspaceManager = new WorkspaceManager(config.sandboxRoot);
  const arenaService = new ArenaService(
    arenaRepo,
    contestantsRepo,
    approvalsService,
    auditRepo,
    workspaceManager,
    false,
  );

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '512kb' }));
  app.use('/api', requireSameOrigin(config));
  app.use('/api', createAttachAuthMiddleware(authService));

  app.use(
    '/api/health',
    createHealthRouter({
      db,
      config,
      contestantsRepo,
      approvalsRepo,
      auditRepo,
      startedAtMs,
    }),
  );

  const { authRouter, usersRouter } = createAuthRouter({
    authService,
    usersRepo,
    auditRepo,
    config,
    disableRateLimit: options?.disableRateLimit,
  });

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/contestants', createContestantsRouter({ contestantsRepo, registry }));
  app.use('/api/approvals', createApprovalsRouter({ approvalsService }));
  app.use('/api/audit-logs', createAuditRouter({ auditRepo }));
  app.use('/api/arena', createArenaRouter({ arenaService }));

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const safeMsg = sanitizeErrorMessage(err);
    if (config.nodeEnv !== 'test') {
      console.error('[api-error]', safeMsg);
    }
    res.status(500).json({ error: 'Internal server error.' });
  });

  return {
    app,
    db,
    config,
    registry,
    arenaService,
    close: async () => {
      await db.close();
    },
  };
}

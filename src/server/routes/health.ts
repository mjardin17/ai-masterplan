import { Router } from 'express';
import { HealthSummary } from '../../shared/types';
import { ServerConfig } from '../config/env';
import { DatabaseClient } from '../db/client';
import { getLatestMigrationName } from '../db/migrations/001_initial_schema';
import { ApprovalsRepository } from '../db/repositories/approvalsRepo';
import { AuditRepository } from '../db/repositories/auditRepo';
import { ContestantsRepository } from '../db/repositories/contestantsRepo';

export function createHealthRouter(deps: {
  db: DatabaseClient;
  config: ServerConfig;
  contestantsRepo: ContestantsRepository;
  approvalsRepo: ApprovalsRepository;
  auditRepo: AuditRepository;
  startedAtMs: number;
}): Router {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      let dbConnected = false;
      let migrationVersion: string | null = null;
      try {
        await deps.db.queryOne<{ ok: number }>('SELECT 1 AS ok');
        dbConnected = true;
        migrationVersion = await getLatestMigrationName(deps.db);
      } catch {
        dbConnected = false;
      }

      const contestants = await deps.contestantsRepo.listAll();
      const summary = {
        total: contestants.length,
        connected: contestants.filter((c) => c.status === 'connected').length,
        unconfigured: contestants.filter((c) => c.status === 'unconfigured').length,
        error: contestants.filter((c) => c.status === 'error').length,
        disabled: contestants.filter((c) => c.status === 'disabled').length,
      };

      const payload: HealthSummary = {
        status: dbConnected ? 'ok' : 'degraded',
        uptimeSeconds: Math.floor((Date.now() - deps.startedAtMs) / 1000),
        timestamp: new Date().toISOString(),
        database: {
          driver: deps.db.driver,
          connected: dbConnected,
          migrationVersion,
          pathLabel: deps.config.sqlitePath.endsWith(':memory:')
            ? ':memory:'
            : 'local-sqlite-db',
        },
        contestants: summary,
      };

      if (req.authUser && dbConnected) {
        const [pending, audit] = await Promise.all([
          deps.approvalsRepo.countPending(),
          deps.auditRepo.verifyChain(),
        ]);
        payload.approvals = { pending };
        payload.audit = audit;
      }

      res.status(dbConnected ? 200 : 503).json(payload);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

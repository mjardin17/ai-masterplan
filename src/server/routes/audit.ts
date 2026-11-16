import { Router } from 'express';
import { requireRole } from '../auth/middleware';
import { AuditRepository } from '../db/repositories/auditRepo';

export function createAuditRouter(deps: { auditRepo: AuditRepository }): Router {
  const router = Router();

  router.get(
    '/',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const action = typeof req.query.action === 'string' ? req.query.action : undefined;
        const resourceType =
          typeof req.query.resourceType === 'string' ? req.query.resourceType : undefined;
        const limit =
          typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : 50;
        const offset =
          typeof req.query.offset === 'string' ? Number.parseInt(req.query.offset, 10) : 0;

        const data = await deps.auditRepo.list({
          action,
          resourceType,
          limit: Number.isFinite(limit) ? limit : 50,
          offset: Number.isFinite(offset) ? offset : 0,
        });
        const verification = await deps.auditRepo.verifyChain();
        res.json({ ...data, verification });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    '/verify',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (_req, res, next) => {
      try {
        const verification = await deps.auditRepo.verifyChain();
        res.json({ verification });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

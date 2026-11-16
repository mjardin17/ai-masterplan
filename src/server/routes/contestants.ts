import { Router } from 'express';
import { ContestantRegistry } from '../adapters/registry';
import { requireRole } from '../auth/middleware';
import { ContestantsRepository } from '../db/repositories/contestantsRepo';

export function createContestantsRouter(deps: {
  contestantsRepo: ContestantsRepository;
  registry: ContestantRegistry;
}): Router {
  const router = Router();

  router.get(
    '/',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (_req, res, next) => {
      try {
        const contestants = await deps.contestantsRepo.listAll();
        res.json({ contestants });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    '/:id/health-check',
    requireRole(['admin', 'operator']),
    async (req, res, next) => {
      try {
        const id = String(req.params.id ?? '');
        const updated = await deps.registry.runHealthCheck(id, req.authUser!);
        if (!updated) {
          res.status(404).json({ error: 'Contestant not found.' });
          return;
        }
        res.json({ contestant: updated });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch('/:id/toggle', requireRole(['admin']), async (req, res, next) => {
    try {
      const id = String(req.params.id ?? '');
      const { isEnabled } = req.body ?? {};
      if (typeof isEnabled !== 'boolean') {
        res.status(400).json({ error: 'isEnabled boolean is required.' });
        return;
      }
      const updated = await deps.registry.setEnabled(id, isEnabled, req.authUser!);
      if (!updated) {
        res.status(404).json({ error: 'Contestant not found.' });
        return;
      }
      res.json({ contestant: updated });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

import { Router } from 'express';
import { ApprovalActionType, ApprovalStatus } from '../../shared/types';
import { ApprovalServiceError, ApprovalsService } from '../approvals/service';
import { requireRole } from '../auth/middleware';

const VALID_STATUSES: ApprovalStatus[] = ['pending', 'approved', 'rejected', 'expired'];

export function createApprovalsRouter(deps: { approvalsService: ApprovalsService }): Router {
  const router = Router();

  router.get(
    '/',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
        if (rawStatus && !VALID_STATUSES.includes(rawStatus as ApprovalStatus)) {
          res.status(400).json({ error: 'Invalid approval status filter.' });
          return;
        }
        const approvals = await deps.approvalsService.list(rawStatus as ApprovalStatus | undefined);
        res.json({ approvals });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post('/', requireRole(['admin', 'operator']), async (req, res, next) => {
    try {
      const { actionType, targetResource, summary, payload, expiresAt } = req.body ?? {};
      const created = await deps.approvalsService.createRequest(req.authUser!, {
        actionType: actionType as ApprovalActionType,
        targetResource: String(targetResource ?? ''),
        summary: String(summary ?? ''),
        payload:
          payload && typeof payload === 'object' && !Array.isArray(payload)
            ? (payload as Record<string, unknown>)
            : {},
        expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
      });
      res.status(201).json({ approval: created });
    } catch (err) {
      if (err instanceof ApprovalServiceError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  router.post('/:id/decide', requireRole(['admin', 'reviewer']), async (req, res, next) => {
    try {
      const id = String(req.params.id ?? '');
      const { decision, decisionNote } = req.body ?? {};
      const updated = await deps.approvalsService.decideRequest(req.authUser!, {
        id,
        decision: decision as 'approved' | 'rejected',
        decisionNote: String(decisionNote ?? ''),
      });
      res.json({ approval: updated });
    } catch (err) {
      if (err instanceof ApprovalServiceError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  return router;
}

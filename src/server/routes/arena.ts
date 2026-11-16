import { Router } from 'express';
import { ArenaCategory } from '../../shared/types';
import { ArenaService, ArenaServiceError } from '../arena/runner';
import { requireRole } from '../auth/middleware';

const VALID_CATEGORIES: ArenaCategory[] = [
  'coding',
  'reasoning',
  'research',
  'debugging',
  'security',
  'recovery',
];

function parseCategoryQuery(raw: unknown): ArenaCategory | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  if (!VALID_CATEGORIES.includes(raw as ArenaCategory)) {
    throw new ArenaServiceError(400, `Invalid category filter: ${raw}`);
  }
  return raw as ArenaCategory;
}

export function createArenaRouter(deps: { arenaService: ArenaService }): Router {
  const router = Router();

  router.get(
    '/tasks',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const category = parseCategoryQuery(req.query.category);
        const tasks = await deps.arenaService.listTasks(category);
        res.json({ tasks });
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/isolation',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    (_req, res) => {
      res.json({ isolation: deps.arenaService.getIsolationCapabilities() });
    },
  );

  router.post(
    '/tasks',
    requireRole(['admin', 'operator']),
    async (req, res, next) => {
      try {
        const body = (req.body ?? {}) as Record<string, unknown>;
        const task = await deps.arenaService.createTask(req.authUser!, {
          title: body.title as string,
          category: body.category as ArenaCategory,
          description:
            body.description === undefined ? '' : (body.description as string),
          instructions: body.instructions as string,
          startingFiles:
            body.startingFiles === undefined
              ? {}
              : (body.startingFiles as Record<string, string>),
          acceptanceChecks: body.acceptanceChecks as never,
          timeLimitMs:
            body.timeLimitMs === undefined ? 5000 : (body.timeLimitMs as number),
          tokenBudget:
            body.tokenBudget === undefined ? 4000 : (body.tokenBudget as number),
          costCapUsd:
            body.costCapUsd === undefined ? 0.5 : (body.costCapUsd as number),
        });
        res.status(201).json({ task });
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/competitions',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const category = parseCategoryQuery(req.query.category);
        const competitions = await deps.arenaService.listCompetitions(category);
        res.json({ competitions });
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/competitions/:id',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const detail = await deps.arenaService.getCompetitionDetail(String(req.params.id ?? ''));
        res.json(detail);
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.post(
    '/competitions',
    requireRole(['admin', 'operator']),
    async (req, res, next) => {
      try {
        const body = req.body ?? {};
        const detail = await deps.arenaService.stageCompetition(req.authUser!, {
          title: String(body.title ?? ''),
          taskId: String(body.taskId ?? ''),
          contestantIds: Array.isArray(body.contestantIds)
            ? body.contestantIds.map((c: unknown) => String(c))
            : [],
          requestApproval: body.requestApproval !== false,
        });
        res.status(201).json(detail);
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.post(
    '/competitions/:id/launch',
    requireRole(['admin', 'operator']),
    async (req, res, next) => {
      try {
        await deps.arenaService.launchLiveCompetition(
          req.authUser!,
          String(req.params.id ?? ''),
        );
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/leaderboard',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const category = parseCategoryQuery(req.query.category);
        const leaderboard = await deps.arenaService.getLeaderboard({ category });
        res.json({ leaderboard });
      } catch (err) {
        if (err instanceof ArenaServiceError) {
          res.status(err.statusCode).json({ error: err.message });
          return;
        }
        next(err);
      }
    },
  );

  router.get(
    '/observations',
    requireRole(['admin', 'operator', 'reviewer', 'viewer']),
    async (req, res, next) => {
      try {
        const competitionId =
          typeof req.query.competitionId === 'string' ? req.query.competitionId : undefined;
        const contestantId =
          typeof req.query.contestantId === 'string' ? req.query.contestantId : undefined;
        const observations = await deps.arenaService.listObservations({
          competitionId,
          contestantId,
        });
        res.json({ observations });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}

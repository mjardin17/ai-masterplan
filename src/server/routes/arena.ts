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

  router.post(
    '/tasks',
    requireRole(['admin', 'operator']),
    async (req, res, next) => {
      try {
        const body = req.body ?? {};
        const task = await deps.arenaService.createTask(req.authUser!, {
          title: String(body.title ?? ''),
          category: body.category as ArenaCategory,
          description: String(body.description ?? ''),
          instructions: String(body.instructions ?? ''),
          startingFiles:
            body.startingFiles &&
            typeof body.startingFiles === 'object' &&
            !Array.isArray(body.startingFiles)
              ? (body.startingFiles as Record<string, string>)
              : {},
          acceptanceChecks: Array.isArray(body.acceptanceChecks)
            ? body.acceptanceChecks
            : [],
          timeLimitMs: Number(body.timeLimitMs ?? 5000),
          tokenBudget: Number(body.tokenBudget ?? 4000),
          costCapUsd: Number(body.costCapUsd ?? 0.5),
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

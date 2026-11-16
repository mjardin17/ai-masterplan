import { Router } from 'express';
import { UserRole } from '../../shared/types';
import { ServerConfig } from '../config/env';
import { hashPassword, parseCookies } from '../auth/crypto';
import {
  clearSessionCookie,
  createRateLimiter,
  requireAuth,
  requireRole,
  setSessionCookie,
} from '../auth/middleware';
import {
  AuthError,
  AuthService,
  SESSION_COOKIE_NAME,
  validateEmail,
  validatePasswordStrength,
} from '../auth/service';
import { AuditRepository } from '../db/repositories/auditRepo';
import { UsersRepository } from '../db/repositories/usersRepo';

const VALID_ROLES: UserRole[] = ['admin', 'operator', 'reviewer', 'viewer'];

export function createAuthRouter(deps: {
  authService: AuthService;
  usersRepo: UsersRepository;
  auditRepo: AuditRepository;
  config: ServerConfig;
  disableRateLimit?: boolean;
}): { authRouter: Router; usersRouter: Router } {
  const authRouter = Router();
  const usersRouter = Router();

  const authRateLimit = deps.disableRateLimit
    ? (_req: unknown, _res: unknown, next: () => void) => next()
    : createRateLimiter({ windowMs: 15 * 60 * 1000, maxRequests: 30 });

  authRouter.get('/status', async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const status = await deps.authService.getStatus(cookies[SESSION_COOKIE_NAME]);
      res.json({
        initialized: status.initialized,
        bootstrapAvailable: status.bootstrapAvailable,
        authenticated: Boolean(status.user),
        user: status.user,
      });
    } catch (err) {
      next(err);
    }
  });

  authRouter.post('/bootstrap', authRateLimit, async (req, res, next) => {
    try {
      const { email, displayName, password } = req.body ?? {};
      const result = await deps.authService.bootstrapInitialAdmin({
        email: String(email ?? ''),
        displayName: String(displayName ?? ''),
        password: String(password ?? ''),
      });
      setSessionCookie(req, res, result.signedCookie, deps.config.sessionTtlHours);
      res.status(201).json({ user: result.user, expiresAt: result.expiresAt });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  authRouter.post('/login', authRateLimit, async (req, res, next) => {
    try {
      const { email, password } = req.body ?? {};
      const result = await deps.authService.login(
        String(email ?? ''),
        String(password ?? ''),
        req.ip,
      );
      setSessionCookie(req, res, result.signedCookie, deps.config.sessionTtlHours);
      res.json({ user: result.user, expiresAt: result.expiresAt });
    } catch (err) {
      if (err instanceof AuthError) {
        res.status(err.statusCode).json({ error: err.message });
        return;
      }
      next(err);
    }
  });

  authRouter.post('/logout', async (req, res, next) => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      await deps.authService.logout(cookies[SESSION_COOKIE_NAME], req.authUser ?? null);
      clearSessionCookie(req, res);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  authRouter.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.authUser });
  });

  usersRouter.get('/', requireRole(['admin']), async (_req, res, next) => {
    try {
      const users = await deps.usersRepo.listAll();
      res.json({ users });
    } catch (err) {
      next(err);
    }
  });

  usersRouter.post('/', requireRole(['admin']), async (req, res, next) => {
    try {
      const { email, displayName, role, password } = req.body ?? {};
      const emailStr = String(email ?? '').trim().toLowerCase();
      const nameStr = String(displayName ?? '').trim();
      const roleVal = String(role ?? '') as UserRole;
      const pwStr = String(password ?? '');

      if (!validateEmail(emailStr)) {
        res.status(400).json({ error: 'Valid email is required.' });
        return;
      }
      if (nameStr.length < 2) {
        res.status(400).json({ error: 'Display name must be at least 2 characters.' });
        return;
      }
      if (!VALID_ROLES.includes(roleVal)) {
        res.status(400).json({ error: 'Invalid role specified.' });
        return;
      }
      const pwErr = validatePasswordStrength(pwStr);
      if (pwErr) {
        res.status(400).json({ error: pwErr });
        return;
      }

      const existing = await deps.usersRepo.findByEmail(emailStr);
      if (existing) {
        res.status(409).json({ error: 'A user with that email already exists.' });
        return;
      }

      const created = await deps.usersRepo.create({
        email: emailStr,
        displayName: nameStr,
        role: roleVal,
        passwordHash: hashPassword(pwStr),
      });

      await deps.auditRepo.append({
        actorType: 'user',
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'user.created',
        resourceType: 'user',
        resourceId: created.id,
        metadata: { email: created.email, role: created.role },
      });

      res.status(201).json({ user: created });
    } catch (err) {
      next(err);
    }
  });

  usersRouter.patch('/:id/role', requireRole(['admin']), async (req, res, next) => {
    try {
      const targetId = String(req.params.id ?? '');
      const { role, isActive } = req.body ?? {};

      const target = await deps.usersRepo.findById(targetId);
      if (!target) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      if (role !== undefined && !VALID_ROLES.includes(role as UserRole)) {
        res.status(400).json({ error: 'Invalid role specified.' });
        return;
      }

      if (targetId === req.authUser!.id) {
        if (role !== undefined && role !== 'admin') {
          const activeAdmins = await deps.usersRepo.countActiveByRoles(['admin']);
          if (activeAdmins <= 1) {
            res.status(409).json({ error: 'Cannot demote the last active administrator.' });
            return;
          }
        }
        if (isActive === false) {
          res.status(409).json({ error: 'Cannot deactivate your own active session.' });
          return;
        }
      }

      const updated = await deps.usersRepo.updateRoleAndStatus(targetId, {
        role: role as UserRole | undefined,
        isActive: typeof isActive === 'boolean' ? isActive : undefined,
      });

      if (!updated) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      await deps.auditRepo.append({
        actorType: 'user',
        actorId: req.authUser!.id,
        actorRole: req.authUser!.role,
        action: 'user.role_updated',
        resourceType: 'user',
        resourceId: updated.id,
        metadata: {
          previousRole: target.role,
          newRole: updated.role,
          isActive: updated.isActive,
        },
      });

      res.json({ user: updated });
    } catch (err) {
      next(err);
    }
  });

  return { authRouter, usersRouter };
}

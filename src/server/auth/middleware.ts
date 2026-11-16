import { NextFunction, Request, Response } from 'express';
import { PublicUser, UserRole } from '../../shared/types';
import { ServerConfig } from '../config/env';
import { parseCookies } from './crypto';
import { AuthService, canRoleAccess, SESSION_COOKIE_NAME } from './service';

declare global {
  namespace Express {
    interface Request {
      authUser?: PublicUser | null;
    }
  }
}

export function createAttachAuthMiddleware(authService: AuthService) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const cookies = parseCookies(req.headers.cookie);
      const rawSession = cookies[SESSION_COOKIE_NAME];
      req.authUser = await authService.authenticateCookie(rawSession);
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.authUser) {
    res.status(401).json({ error: 'Authentication required.' });
    return;
  }
  next();
}

export function requireRole(allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.authUser) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!canRoleAccess(req.authUser.role, allowedRoles)) {
      res.status(403).json({
        error: `Forbidden: requires role ${allowedRoles.join(' or ')}.`,
      });
      return;
    }
    next();
  };
}

export function requireSameOrigin(config: ServerConfig) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next();
      return;
    }
    const origin = req.headers.origin;
    if (!origin) {
      next();
      return;
    }
    const host = req.headers.host;
    try {
      const originHost = new URL(origin).host;
      const allowedHosts = new Set<string>();
      if (host) allowedHosts.add(host);
      if (config.appUrl) {
        allowedHosts.add(new URL(config.appUrl).host);
      }
      if (!allowedHosts.has(originHost)) {
        res.status(403).json({ error: 'Cross-origin state mutation rejected.' });
        return;
      }
      next();
    } catch {
      res.status(403).json({ error: 'Invalid Origin header.' });
    }
  };
}

export function createRateLimiter(options: { windowMs: number; maxRequests: number }) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      next();
      return;
    }

    if (existing.count >= options.maxRequests) {
      const retryAfterSec = Math.ceil((existing.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: 'Too many authentication attempts. Please wait and try again.',
      });
      return;
    }

    existing.count += 1;
    next();
  };
}

export function isHttpsRequest(req: Request): boolean {
  if (req.secure) return true;
  const forwarded = req.headers['x-forwarded-proto'];
  if (typeof forwarded === 'string') {
    return forwarded.split(',')[0].trim().toLowerCase() === 'https';
  }
  return false;
}

export function setSessionCookie(req: Request, res: Response, signedCookie: string, ttlHours: number): void {
  const https = isHttpsRequest(req);
  res.cookie(SESSION_COOKIE_NAME, signedCookie, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    path: '/',
    maxAge: ttlHours * 60 * 60 * 1000,
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  const https = isHttpsRequest(req);
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    path: '/',
  });
}

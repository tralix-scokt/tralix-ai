import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Repository } from './db.js';
import type { UserProfile } from '../shared/types.js';

export const SESSION_COOKIE_NAME = 'tralix_session';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserProfile;
    sessionToken?: string;
  }
}

/** Hash password using Node's built-in scrypt with random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, derivedKey) => {
      if (err) return reject(err);
      resolve(`scrypt$${salt}$${derivedKey.toString('hex')}`);
    });
  });
}

/** Verify password against a scrypt hash using timing-safe comparison. */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = parts[1];
  const expected = Buffer.from(parts[2], 'hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, expected.length, (err, derivedKey) => {
      if (err) return reject(err);
      try {
        resolve(crypto.timingSafeEqual(derivedKey, expected));
      } catch {
        resolve(false);
      }
    });
  });
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');

export function setSessionCookie(res: Response, token: string, isProduction: boolean) {
  res.cookie(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/',
  });
}

export function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
  });
}

/**
 * Middleware that extracts user from session cookie or Authorization Bearer header.
 * Populates req.user if found, but does NOT reject if unauthenticated.
 */
export function resolveUser(repo: Repository) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const cookieToken = (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE_NAME];
      const header = req.headers.authorization ?? '';
      const bearerToken = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
      const token = cookieToken || bearerToken;

      if (token && token.length <= 128) {
        // Try session first
        let user = await repo.getUserBySession(token);
        // Fallback to anonymous device token hash (backward compatibility)
        if (!user) {
          user = await repo.getUserByToken(token);
        }
        if (user) {
          req.user = user;
          req.sessionToken = token;
        }
      }
    } catch (e) {
      console.error('[auth] error resolving user:', (e as Error)?.message);
    }
    next();
  };
}

/**
 * Middleware that requires an authenticated user.
 */
export function requireUser() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      res.status(401).json({ error: 'Session expired or not logged in. Please reload or log in.' });
      return;
    }
    next();
  };
}

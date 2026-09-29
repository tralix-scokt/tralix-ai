import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Repository } from './db.js';
import type { UserProfile } from '../shared/types.js';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserProfile;
  }
}

/**
 * V1 identity: each browser gets an anonymous device token (created by
 * POST /api/session, stored client-side, sent as `Authorization: Bearer`).
 * Only a SHA-256 hash of the token is stored server-side, and every query is
 * scoped by user id, so conversations are private per device.
 *
 * To add real accounts later, replace `requireUser` with a middleware that
 * resolves `req.user` from a session/JWT — nothing else in the app changes.
 */
export const newToken = () => crypto.randomBytes(32).toString('base64url');

export function requireUser(repo: Repository) {
  return (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const user = token && token.length <= 128 ? repo.getUserByToken(token) : null;
    if (!user) {
      res.status(401).json({ error: 'Session expired. Please reload the page.' });
      return;
    }
    req.user = user;
    next();
  };
}

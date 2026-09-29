import type { NextFunction, Request, Response } from 'express';

/** Small fixed-window in-memory rate limiter. Swap for Redis when scaling horizontally. */
export function rateLimit(opts: { windowMs: number; max: number; key: (req: Request) => string; message?: string }) {
  const hits = new Map<string, { count: number; reset: number }>();
  const sweeper = setInterval(() => {
    const t = Date.now();
    for (const [k, v] of hits) if (v.reset <= t) hits.delete(k);
  }, opts.windowMs);
  sweeper.unref();

  return (req: Request, res: Response, next: NextFunction) => {
    const k = opts.key(req);
    const t = Date.now();
    let h = hits.get(k);
    if (!h || h.reset <= t) {
      h = { count: 0, reset: t + opts.windowMs };
      hits.set(k, h);
    }
    h.count++;
    res.setHeader('RateLimit-Remaining', Math.max(0, opts.max - h.count));
    if (h.count > opts.max) {
      res.setHeader('Retry-After', Math.ceil((h.reset - t) / 1000));
      res.status(429).json({ error: opts.message ?? 'Too many requests. Please slow down and try again shortly.' });
      return;
    }
    next();
  };
}

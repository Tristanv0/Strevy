import { createHash, timingSafeEqual } from 'node:crypto';
import express, { Router } from 'express';
import { BadmintonSyncError, parsePhoneWorkouts } from '../lib/badminton-sync.js';

const hash = value => createHash('sha256').update(value).digest();

export default function createAppleHealthRouter(store, token) {
  const router = Router();
  const configured = typeof token === 'string' && token.length >= 32 && store?.mergeSync && store?.bootstrapSync;
  const expected = configured ? hash(`Bearer ${token}`) : null;
  const json = express.json({ limit: '8mb', inflate: false });

  function authorize(req, res, next) {
    res.set('Cache-Control', 'no-store');
    if (!expected) return res.status(503).json({ error: 'Apple Health sync is not configured.' });
    if (!timingSafeEqual(expected, hash(req.get('authorization') ?? ''))) {
      res.set('WWW-Authenticate', 'Bearer');
      return res.status(401).json({ error: 'Invalid sync token.' });
    }
    if (!req.is('application/json')) return res.status(415).json({ error: 'Expected application/json.' });
    next();
  }

  function post(path, process) {
    router.post(path, authorize, json, async (req, res, next) => {
      try {
        res.json({ ok: true, ...await process(req.body) });
      } catch (error) {
        if (error instanceof BadmintonSyncError) return res.status(error.status).json({ error: error.message });
        next(error);
      }
    });
  }

  post('/bootstrap', body => store.bootstrapSync(body));
  post('/sync', async body => {
    if (body?.workouts === undefined && (body?.test === true || body?.type === 'test')) return { test: true };
    const batch = parsePhoneWorkouts(body);
    if (!batch.matches.length) return { added: 0, duplicates: 0, outsideWindow: 0, ignored: batch.ignored };
    return store.mergeSync(batch);
  });
  return router;
}

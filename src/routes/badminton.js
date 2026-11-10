import { Router } from 'express';
import { retainBadmintonDays } from '../lib/badminton.js';

export default function createBadmintonRouter(store) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      const snapshot = await store?.readSnapshot();
      res.set('Cache-Control', 'no-store');
      if (snapshot == null) return res.status(503).json({ error: 'Badminton data is not available yet.' });
      res.json(retainBadmintonDays(snapshot));
    } catch (error) {
      next(error);
    }
  });
  return router;
}

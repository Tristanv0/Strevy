import { Router } from 'express';

export default function createWorkoutsRouter(store) {
  const router = Router();
  router.get('/', async (req, res, next) => {
    try {
      const snapshot = store ? await store.readSnapshot() : null;
      res.set('Cache-Control', 'no-store');
      if (snapshot === null) {
        return res.status(503).json({ error: 'Workout data is not available yet.' });
      }
      res.json(snapshot);
    } catch (error) {
      next(error);
    }
  });
  return router;
}

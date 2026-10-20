import { Router } from 'express';
import { isMediaKey, withMediaUrl } from '../lib/media.js';

export default function createRunsRouter(store) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      // Read the latest completed scrape from disk or R2 on every request.
      const snapshot = await store.readSnapshot();
      if (snapshot === null) {
        return res.status(503).json({ error: 'Run data is not available yet.' });
      }
      const runs = snapshot.runs.map(run => ({
        ...run,
        routeImage: withMediaUrl(run.routeImage, req.baseUrl),
        mapImage: withMediaUrl(run.mapImage, req.baseUrl),
        photos: run.photos.map(photo => withMediaUrl(photo, req.baseUrl)),
      }));
      res.set('Cache-Control', 'no-store');
      res.json({ ...snapshot, runs });
    } catch (error) {
      next(error);
    }
  });

  router.get('/media/:activityId/:filename', async (req, res, next) => {
    try {
      const key = `media/${req.params.activityId}/${req.params.filename}`;
      if (!isMediaKey(key)) return next();
      const image = await store.readMedia(key);
      if (!image) return next();
      res.set('Content-Type', image.contentType);
      res.set('Cache-Control', 'public, max-age=0, must-revalidate');
      if (image.etag) res.set('ETag', image.etag);
      res.send(image.body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}

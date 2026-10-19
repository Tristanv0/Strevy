import { Router, static as serveStatic } from 'express';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const router = Router();
const outputDirectory = new URL('../../scrapers/strava/output/', import.meta.url);
const snapshotPath = new URL('latest-runs.json', outputDirectory);

function withMediaUrl(media, baseUrl) {
  if (!media?.path) return media;
  return { ...media, url: `${baseUrl}/${media.path}` };
}

router.get('/', async (req, res, next) => {
  try {
    // Read the latest completed scrape on each request, rather than caching an import.
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
    const runs = snapshot.runs.map(run => ({
      ...run,
      routeImage: withMediaUrl(run.routeImage, req.baseUrl),
      mapImage: withMediaUrl(run.mapImage, req.baseUrl),
      photos: run.photos.map(photo => withMediaUrl(photo, req.baseUrl)),
    }));
    res.set('Cache-Control', 'no-store');
    res.json({ ...snapshot, runs });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return res.status(503).json({ error: 'Run data is not available yet.' });
    }
    next(error);
  }
});

// Only the media folder is exposed; other scraper files remain inaccessible.
router.use('/media', serveStatic(fileURLToPath(new URL('media/', outputDirectory)), {
  dotfiles: 'deny',
  index: false,
  redirect: false,
  maxAge: 0,
}));

export default router;

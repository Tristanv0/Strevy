import { mkdir, rename, writeFile } from 'node:fs/promises';
import { normalizeRoute, selectOwnPhotos, routePng } from './run-media.mjs';
import { collectMapImages } from './map-view.mjs';

const number = value => value === null || value === undefined || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;

export function applyRunDetails(run, detail) {
  const distanceMeters = number(detail.distanceMeters);
  const movingSeconds = number(detail.movingTimeSeconds) ?? run.movingTime.seconds;
  const speed = number(detail.averageSpeedMps);
  const fallbackMeters = run.distance.value === null ? null
    : run.distance.unit === 'km' ? run.distance.value * 1_000
      : run.distance.unit === 'mi' ? run.distance.value * 1_609.344 : null;
  const meters = distanceMeters ?? fallbackMeters;
  const secondsPerKm = speed > 0 ? Math.round(1_000 / speed)
    : meters > 0 && movingSeconds !== null ? Math.round(movingSeconds * 1_000 / meters) : null;
  const heartRate = number(detail.averageHeartRateBpm);
  const elevation = number(detail.elevationGainMeters)
    ?? (run.elevationGain.unit === 'm' ? run.elevationGain.value
      : run.elevationGain.unit === 'ft' && run.elevationGain.value !== null
        ? Number((run.elevationGain.value * 0.3048).toFixed(2)) : null);
  return {
    ...run,
    distanceMeters: meters,
    averageHeartRateBpm: heartRate > 0 ? Number(heartRate.toFixed(2)) : null,
    averagePacePerKm: secondsPerKm === null ? null : {
      display: `${Math.floor(secondsPerKm / 60)}:${String(secondsPerKm % 60).padStart(2, '0')} /km`,
      secondsPerKm,
      calculatedFromDisplayedDistance: speed <= 0 && distanceMeters === null,
    },
    elevationGainMeters: elevation,
    relativeEffort: number(detail.relativeEffort) ?? run.relativeEffort,
    photos: [],
    routeImage: null,
    mapImage: null,
    mediaWarnings: [],
  };
}

async function readRunDetails(page, run, athleteId) {
  const response = await page.goto(run.url, { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new Error(`Run ${run.id} returned HTTP ${response?.status() || 'unknown'}.`);
  if (new URL(page.url()).pathname !== `/activities/${run.id}`) {
    throw new Error(`Strava did not open run ${run.id}.`);
  }
  await page.waitForFunction(() => typeof window.pageView?.activity === 'function', { timeout: 0 });
  // Let the page's own map/stream requests finish. Missing optional media must not block the export.
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 15_000 }).catch(() => {});
  const detail = await page.evaluate(async () => {
    const view = window.pageView;
    const raw = view.activity().attributes;
    const streamArray = type => {
      const value = view._streams?.getStream?.(type) ?? view._streams?.streamData?.[type];
      return Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : [];
    };
    try {
      if (view._latlngRequest) await Promise.resolve(view._latlngRequest);
    } catch {
      // A run can have metrics without a downloadable GPS route.
    }
    const items = [...document.querySelectorAll('#activity-photos-container [data-react-class="MediaThumbnailList"]')]
      .flatMap(element => {
        try { return JSON.parse(element.getAttribute('data-react-props')).items || []; }
        catch { return []; }
      });
    return {
      id: String(raw.id), athleteId: String(raw.activityAthleteId), isOwner: view._isOwner === true,
      type: raw.type, distanceMeters: raw.distance, movingTimeSeconds: raw.moving_time,
      averageSpeedMps: raw.avg_speed, averageHeartRateBpm: raw.avg_hr,
      elevationGainMeters: raw.elev_gain,
      relativeEffort: document.querySelector('.inline-stats .suffer-score strong')?.textContent.trim() || null,
      photos: items.map(item => ({
        photo_id: item.photo_id, id: item.id, media_type: item.media_type,
        activity_id_str: item.activity_id_str, activity_id: item.activity_id,
        owner_id: item.owner_id, large: item.large, thumbnail: item.thumbnail,
      })),
      latlng: streamArray('latlng'), privacy: streamArray('privacy'),
    };
  });
  if (detail.id !== run.id || !detail.isOwner || detail.athleteId !== String(athleteId)) {
    throw new Error(`Ownership verification failed for run ${run.id}; no media or metrics were exported.`);
  }
  if (detail.type !== 'Run' && !['TrailRun', 'VirtualRun'].includes(detail.type)) {
    throw new Error(`Activity ${run.id} is no longer classified as a run.`);
  }
  return detail;
}

async function savePng(directory, filename, dataUrl) {
  if (!dataUrl.startsWith('data:image/png;base64,')) throw new Error('Image rendering failed.');
  const path = new URL(filename, directory);
  const temporary = new URL(`${filename}.tmp`, directory);
  await writeFile(temporary, Buffer.from(dataUrl.split(',')[1], 'base64'), { mode: 0o600 });
  await rename(temporary, path);
}

export async function enrichRuns(page, runs, { athleteId, outputDirectory, pause } = {}) {
  let mapImages = new Map();
  try {
    console.log('Reading static map image URLs from your athlete feed.');
    mapImages = await collectMapImages(page, runs, athleteId);
    console.log(`Found static map images for ${mapImages.size} of ${runs.length} runs.`);
  } catch (error) {
    console.warn(`Static map images unavailable: ${error.message}`);
  }
  // Render route images on a blank page outside the signed-in Strava context.
  const mediaContext = await page.browser().createBrowserContext();
  const renderer = await mediaContext.newPage();
  const results = [];
  try {
    for (const run of runs) {
      if (!/^\d+$/.test(run.id)) throw new Error('Invalid run ID.');
      await pause();
      const detail = await readRunDetails(page, run, athleteId);
      const result = applyRunDetails(run, detail);
      result.photos = selectOwnPhotos(detail.photos, run.id, athleteId);
      const relativeDirectory = `media/${run.id}/`;
      const directory = new URL(relativeDirectory, outputDirectory);
      const segments = normalizeRoute(detail.latlng, detail.privacy);
      if (segments.length) {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await savePng(directory, 'route.png', await routePng(renderer, segments));
        result.routeImage = {
          path: relativeDirectory + 'route.png', width: 768, height: 768,
          background: 'transparent', containsBasemap: false, privacyMaskApplied: true,
          containsGpsMetadata: false,
        };
      } else {
        result.mediaWarnings.push('No visible GPS route with a matching privacy mask was available.');
      }
      // Only attach the feed image after this activity's ownership was verified.
      result.mapImage = mapImages.get(run.id) ?? null;
      if (!result.mapImage) result.mediaWarnings.push('No static map image URL was found for this run in your athlete feed.');
      // Do not copy raw GPS coordinates, privacy masks, or photo geotags into JSON.
      results.push(result);
      console.log(`Run ${run.id}: metrics collected, ${result.photos.length} uploaded photos, route ${result.routeImage ? 'exported' : 'unavailable'}, map ${result.mapImage ? 'exported' : 'unavailable'}.`);
    }
    return results;
  } finally {
    await mediaContext.close();
  }
}

import { setTimeout as delay } from 'node:timers/promises';
import { approvedPhotoUrl } from './run-media.mjs';

// Runs in the browser. Associate each static map with its activity link, never
// with the card's position in the feed or another run's nearby photo.
export function readFeedMapImages(activityIds) {
  const wanted = new Set(activityIds);
  const images = [];
  for (const image of document.querySelectorAll('img[data-testid="map"]')) {
    const link = image.closest('a[href]');
    if (!link) continue;
    const activity = new URL(link.href, location.href);
    const match = activity.pathname.match(/^\/activities\/(\d+)\/?$/);
    if (activity.origin !== location.origin || !match || !wanted.has(match[1])) continue;
    const src = image.currentSrc || image.getAttribute('src');
    if (!src) continue;
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    images.push({
      id: match[1], url: new URL(src, location.href).href,
      ...(width > 0 && height > 0 ? { width, height } : {}),
    });
  }
  return images;
}

export function selectMapImages(images, activityIds) {
  const wanted = new Set(activityIds);
  const selected = new Map();
  for (const image of images) {
    if (!wanted.has(image.id)) continue;
    const url = approvedPhotoUrl(image.url);
    if (!url) continue;
    selected.set(image.id, {
      url,
      ...(Number.isFinite(image.width) && image.width > 0
        && Number.isFinite(image.height) && image.height > 0
        ? { width: image.width, height: image.height } : {}),
      containsBasemap: true,
      source: 'strava-feed-map',
    });
  }
  return selected;
}

// Follow week links actually exposed by this profile rather than constructing
// an undocumented feed request. The profile initially shows only one week.
export function readProfileWeekLinks(path) {
  const links = new Map();
  for (const link of document.querySelectorAll('a[href]')) {
    const url = new URL(link.href, location.href);
    if (url.origin !== location.origin || url.pathname !== path || !url.hash.startsWith('#interval?')) continue;
    const params = new URLSearchParams(url.hash.slice('#interval?'.length));
    const interval = params.get('interval');
    if (params.get('interval_type') !== 'week' || !/^\d{6}$/.test(interval ?? '')) continue;
    const year = Number(interval.slice(0, 4));
    const week = Number(interval.slice(4));
    if (week < 1 || week > 53) continue;
    const january4 = new Date(Date.UTC(year, 0, 4));
    const start = january4.getTime() - ((january4.getUTCDay() + 6) % 7) * 86_400_000
      + (week - 1) * 7 * 86_400_000;
    links.set(interval, { href: url.href, start, end: start + 7 * 86_400_000 });
  }
  return [...links.values()].sort((left, right) => right.start - left.start);
}

export async function collectMapImages(page, runs, athleteId, { timeout = 20_000 } = {}) {
  if (!/^\d+$/.test(String(athleteId))) throw new Error('Invalid athlete ID.');
  const ids = runs.map(run => run.id);
  if (!ids.length) return new Map();
  const path = `/athletes/${athleteId}`;
  const response = await page.goto(`https://www.strava.com${path}`, {
    waitUntil: 'domcontentloaded', timeout: 30_000,
  });
  if (!response?.ok() || new URL(page.url()).origin !== 'https://www.strava.com'
    || new URL(page.url()).pathname !== path) {
    throw new Error('Could not open your athlete feed to read static map images.');
  }

  const selected = new Map();
  const deadline = Date.now() + timeout;
  async function scan(expectedIds, stopAfterFirst = false) {
    const viewDeadline = Math.min(deadline, Date.now() + 5_000);
    do {
      const images = selectMapImages(await page.evaluate(readFeedMapImages, ids), ids);
      for (const [id, image] of images) selected.set(id, image);
      if (expectedIds.every(id => selected.has(id)) || (stopAfterFirst && selected.size > 0)
        || Date.now() >= viewDeadline) break;
      await page.evaluate(() => window.scrollBy(0, Math.max(600, window.innerHeight * 0.8)));
      await delay(250);
    } while (Date.now() < viewDeadline);
  }
  await scan(ids, true);
  if (selected.size === ids.length) return selected;
  const weeks = await page.evaluate(readProfileWeekLinks, path);
  for (const week of weeks) {
    if (Date.now() >= deadline || selected.size === ids.length) break;
    const expected = runs.filter(run => {
      if (selected.has(run.id)) return false;
      const date = Date.parse(run.startTime);
      // Allow a day at either edge for the profile's local time zone.
      return !Number.isFinite(date) || (date >= week.start - 86_400_000 && date < week.end + 86_400_000);
    }).map(run => run.id);
    if (!expected.length) continue;
    try {
      await page.goto(week.href, { waitUntil: 'domcontentloaded', timeout: Math.max(1, deadline - Date.now()) });
    } catch {
      break; // Keep already collected images if an older week cannot be opened.
    }
    await scan(expected);
  }
  return selected;
}

const RUN_SPORT_TYPES = new Set(['Run', 'TrailRun', 'VirtualRun']);
const HISTORY_PATH = '/athlete/training';
const HISTORY_DATA_PATH = '/athlete/training_activities';

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(String(value).replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function durationSeconds(raw, display) {
  const seconds = numeric(raw);
  if (seconds !== null) return seconds;
  const parts = String(display || '').split(':');
  if (parts.length < 2 || !parts.every(part => /^\d+$/.test(part))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

export function activityTimestamp(activity) {
  const timestamp = Date.parse(activity.start_time);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Activity ${activity.id_str || activity.id} has no valid start time.`);
  }
  return timestamp;
}

export function selectLatestRuns(activities, limit = 5) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Run limit must be a positive integer.');
  const runs = new Map();
  for (const activity of activities) {
    if (!RUN_SPORT_TYPES.has(activity.sport_type)) continue;
    const id = activity.id_str || String(activity.id || '');
    if (!/^\d+$/.test(id)) throw new Error('A run has no valid activity ID.');
    activityTimestamp(activity);
    runs.set(id, activity);
  }
  return [...runs.values()]
    .sort((left, right) => activityTimestamp(right) - activityTimestamp(left))
    .slice(0, limit);
}

export function runRecord(activity) {
  if (!RUN_SPORT_TYPES.has(activity.sport_type)) throw new Error('Only running activities can be exported.');
  const id = activity.id_str || String(activity.id);
  if (!/^\d+$/.test(id)) throw new Error('Invalid activity ID.');
  const distance = numeric(activity.distance);
  const unit = activity.short_unit || null;
  const movingSeconds = durationSeconds(activity.moving_time_raw, activity.moving_time);
  const paceSeconds = distance > 0 && movingSeconds !== null && ['km', 'mi'].includes(unit)
    ? Math.round(movingSeconds / distance) : null;
  return {
    id,
    name: activity.name,
    sportType: activity.sport_type,
    startTime: new Date(activityTimestamp(activity)).toISOString(),
    dateLabel: activity.start_date,
    distance: { value: distance, unit },
    movingTime: { display: activity.moving_time || null, seconds: movingSeconds },
    elapsedTime: {
      display: activity.elapsed_time || null,
      seconds: durationSeconds(activity.elapsed_time_raw, activity.elapsed_time),
    },
    // Derived from the displayed distance, which Strava may round.
    averagePace: paceSeconds === null ? null : {
      display: `${Math.floor(paceSeconds / 60)}:${String(paceSeconds % 60).padStart(2, '0')} /${unit}`,
      secondsPerUnit: paceSeconds,
      unit,
      calculatedFromDisplayedDistance: true,
    },
    elevationGain: { value: numeric(activity.elevation_gain), unit: activity.elevation_unit || null },
    relativeEffort: numeric(activity.suffer_score),
    description: activity.description || null,
    url: `https://www.strava.com/activities/${id}`,
  };
}

export async function scrapeLatestRuns(page, { limit = 5, clickAndPause, pause } = {}) {
  // My Activities is scoped by Strava to the signed-in account, unlike the dashboard feed.
  const historyLink = await page.evaluate((path) => [...document.querySelectorAll('a[href]')]
    .map(link => new URL(link.href))
    .find(url => url.origin === location.origin && url.pathname === path)?.href, HISTORY_PATH);
  if (!historyLink) throw new Error('Could not find the signed-in account’s My Activities link.');

  const waitForHistoryResponse = () => page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.origin === 'https://www.strava.com' && url.pathname === HISTORY_DATA_PATH;
  }, { timeout: 0 });

  let [response] = await Promise.all([
    waitForHistoryResponse(),
    page.goto(historyLink, { waitUntil: 'domcontentloaded' }),
  ]);
  const candidates = [];
  const seenIds = new Set();
  let previousPage = 0;
  let oldestTimestamp = Infinity;
  while (true) {
    if (!response.ok()) {
      throw new Error(`My Activities returned HTTP ${response.status()}. No retry was attempted.`);
    }
    const data = await response.json();
    if (!Array.isArray(data.models) || !Number.isInteger(Number(data.total)) || Number(data.total) < 0
      || !Number.isInteger(Number(data.page)) || Number(data.page) < 1) {
      throw new Error('The My Activities response format has changed.');
    }
    if (Number(data.page) <= previousPage) throw new Error('Activity pagination did not advance.');
    previousPage = Number(data.page);
    let newIds = 0;
    for (const activity of data.models) {
      const id = activity.id_str || String(activity.id);
      if (seenIds.has(id)) continue;
      const timestamp = activityTimestamp(activity);
      if (timestamp > oldestTimestamp) {
        throw new Error('My Activities is not sorted newest first; refusing to export an incorrect latest-five result.');
      }
      oldestTimestamp = timestamp;
      seenIds.add(id);
      newIds += 1;
      if (RUN_SPORT_TYPES.has(activity.sport_type)) candidates.push(activity);
    }
    const selected = selectLatestRuns(candidates, limit);
    if (selected.length >= limit || seenIds.size >= Number(data.total)) {
      return selected.map(runRecord);
    }
    if (newIds === 0) throw new Error('Activity pagination ended early or repeated the same activities.');

    await pause();
    const nextHandle = await page.waitForFunction(() => [...document.querySelectorAll('a')].find(link => {
      const label = link.textContent.trim();
      const isNext = link.rel === 'next' || label === '→' || /^next$/i.test(label);
      return isNext && link.getClientRects().length > 0
        && !link.closest('.disabled') && link.getAttribute('aria-disabled') !== 'true';
    }), { timeout: 0 });
    const next = nextHandle.asElement();
    [response] = await Promise.all([
      waitForHistoryResponse(),
      clickAndPause(page, next),
    ]);
  }
}

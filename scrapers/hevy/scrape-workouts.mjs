import { setTimeout as delay } from 'node:timers/promises';
import { loginHevy } from './login.mjs';
import { assertOwnWorkout, calendarMonthWindow, timestamp, workoutReport } from './workout-data.mjs';

export function observeHevyData(page) {
  const state = { account: null, preferences: {}, workouts: new Map(), totalCount: null,
    historyBatches: 0, error: null };
  const pending = new Set();
  const onResponse = response => {
    const url = new URL(response.url());
    if (url.origin !== 'https://api.hevyapp.com' || response.request().method() === 'OPTIONS'
      || !['/user/account', '/v2/user_preferences', '/workout_count', '/user_workouts_paged'].includes(url.pathname)) return;
    const task = (async () => {
      // A cached duplicate has no new payload; previously observed data is retained.
      if (response.status() === 304) return;
      if (response.status() !== 200) throw new Error(`Hevy returned HTTP ${response.status()} while reading your profile.`);
      const data = await response.json();
      if (url.pathname === '/user/account') {
        if (!data?.id || !data.username) throw new Error('Hevy did not identify the signed-in account.');
        state.account = { id: data.id, username: data.username };
      } else if (url.pathname === '/v2/user_preferences') {
        state.preferences = { weight_unit: data.weight_unit };
      } else if (url.pathname === '/workout_count') {
        if (!Number.isInteger(data.workout_count) || data.workout_count < 0) return;
        state.totalCount = data.workout_count;
      } else {
        if (!Array.isArray(data?.workouts)) throw new Error('Hevy workout history format has changed.');
        const username = url.searchParams.get('username');
        if (!username) throw new Error('Hevy did not scope its workout history to a user.');
        let previous = Infinity;
        for (const workout of data.workouts) {
          const started = timestamp(workout.start_time);
          if (started === null || started > previous) throw new Error('Hevy workout history is not newest first.');
          if (workout.username !== username) throw new Error('Hevy returned an unexpected workout owner.');
          previous = started;
          state.workouts.set(workout.id, workout);
        }
        state.historyBatches++;
      }
    })().catch(() => {
      // Do not include raw backend bodies, auth responses, or credentials in errors.
      state.error = new Error(`Could not read Hevy profile data (${url.pathname}, HTTP ${response.status()}).`);
    });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  page.on('response', onResponse);
  return {
    state,
    async flush() {
      await Promise.all([...pending]);
      if (state.error) throw state.error;
    },
    dispose() { page.off('response', onResponse); },
  };
}

async function waitUntil(recorder, predicate, message, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  do {
    await recorder.flush();
    if (predicate()) return;
    await delay(200);
  } while (Date.now() < deadline);
  throw new Error(message);
}

export async function collectProfileWorkouts(page, recorder, { now = new Date(), timeZone = 'America/Toronto' } = {}) {
  const state = recorder.state;
  await waitUntil(recorder, () => !!state.account, 'Could not verify the signed-in Hevy account.');
  await page.goto('https://hevy.com/profile', { waitUntil: 'domcontentloaded' });
  await waitUntil(recorder, () => state.historyBatches > 0 || state.totalCount === 0,
    'Hevy did not load your workout history.');
  if (state.totalCount === 0) return [];
  await page.waitForSelector('a[href^="/workout/"], a[href^="https://hevy.com/workout/"]',
    { visible: true, timeout: 30_000 });
  const period = calendarMonthWindow(now, timeZone);
  const cutoff = Date.parse(period.start);
  const end = Date.parse(period.end);
  let stalePages = 0;
  for (let step = 0; step < 500; step++) {
    await recorder.flush();
    const workouts = [...state.workouts.values()];
    for (const workout of workouts) assertOwnWorkout(workout, state.account);
    const oldest = workouts.length ? Math.min(...workouts.map(workout => timestamp(workout.start_time))) : Infinity;
    const eligibleCount = workouts.filter(workout => timestamp(workout.start_time) <= end).length;
    if (oldest < cutoff && eligibleCount >= 5
      || state.totalCount !== null && workouts.length >= state.totalCount) return workouts;
    const count = workouts.length;
    const batches = state.historyBatches;
    console.log(`Hevy: collected ${count} of your workouts; checking older entries.`);
    // Hevy scrolls an inner container, not the browser window.
    await page.evaluate(() => {
      const candidates = [...document.querySelectorAll('div')].filter(element => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 100 && element.scrollHeight > element.clientHeight + 100
          && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY);
      }).sort((a, b) => b.scrollHeight - a.scrollHeight);
      const target = candidates[0] ?? document.scrollingElement;
      // Move off the intersection boundary before scrolling to the next page.
      target.scrollTop = Math.max(0, target.scrollHeight - target.clientHeight - 100);
      requestAnimationFrame(() => { target.scrollTop = target.scrollHeight; });
    });
    await waitUntil(recorder, () => state.historyBatches > batches,
      'Hevy stopped loading history before the current month and latest five workouts were complete; previous output was preserved.');
    if (state.workouts.size === count) stalePages++; else stalePages = 0;
    if (stalePages >= 3) throw new Error('Hevy history pagination did not advance.');
    await delay(500);
  }
  throw new Error('Hevy history exceeded the pagination limit; previous output was preserved.');
}

export async function scrapeHevyWorkouts(page, { email, password, now = new Date(), timeZone = 'America/Toronto' }) {
  await page.setCacheEnabled(false);
  // Observe before login so the first cached page and user identity are not missed.
  const recorder = observeHevyData(page);
  try {
    await loginHevy(page, { email, password });
    console.log('Hevy: login confirmed. Reading your own profile.');
    const workouts = await collectProfileWorkouts(page, recorder, { now, timeZone });
    return workoutReport(workouts, {
      account: recorder.state.account, preferences: recorder.state.preferences, now, timeZone,
    });
  } finally {
    recorder.dispose();
  }
}

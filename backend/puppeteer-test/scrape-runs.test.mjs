import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLatestRuns, runRecord, scrapeLatestRuns } from './scrape-runs.mjs';

const activity = (id, sport, date, extra = {}) => ({
  id_str: String(id), name: 'Afternoon run', sport_type: sport,
  start_time: date, distance: '5.00', short_unit: 'km',
  moving_time: '25:00', moving_time_raw: 1500,
  elapsed_time: '27:00', elapsed_time_raw: 1620,
  elevation_gain: '20', elevation_unit: 'm', ...extra,
});

test('filters sports before taking five, even when a Hevy workout title mentions running', () => {
  const runs = Array.from({ length: 7 }, (_, index) => activity(index + 1, 'Run', `2026-10-${10 + index}T12:00:00Z`));
  const hevy = activity(99, 'WeightTraining', '2026-10-18T12:00:00Z', { name: 'Push + calm jog' });
  assert.deepEqual(selectLatestRuns([hevy, ...runs]).map(run => run.id_str), ['7', '6', '5', '4', '3']);
});

test('includes trail and virtual runs but excludes walks and rides', () => {
  const sports = ['Run', 'TrailRun', 'VirtualRun', 'Walk', 'Ride'];
  const result = selectLatestRuns(sports.map((sport, index) => activity(index + 1, sport, '2026-10-12T12:00:00Z')));
  assert.deepEqual(result.map(run => run.sport_type), ['Run', 'TrailRun', 'VirtualRun']);
});

test('deduplicates activities across pages and sorts by actual time including offsets', () => {
  const older = activity(1, 'Run', '2026-10-12T13:00:00+02:00');
  const newer = activity(2, 'Run', '2026-10-12T12:00:00Z');
  assert.deepEqual(selectLatestRuns([older, newer, older]).map(run => run.id_str), ['2', '1']);
});

test('exports fewer than five when that is all the account has', () => {
  assert.equal(selectLatestRuns([activity(1, 'Run', '2026-10-12T12:00:00Z')]).length, 1);
  assert.deepEqual(selectLatestRuns([]), []);
});

test('preserves units and missing values, and calculates pace from moving time', () => {
  const result = runRecord(activity(1, 'Run', '2026-10-12T12:00:00Z'));
  assert.deepEqual(result.distance, { value: 5, unit: 'km' });
  assert.equal(result.averagePace.display, '5:00 /km');
  assert.equal(result.elapsedTime.seconds, 1620);
  assert.equal(result.relativeEffort, null);
  assert.equal(result.url, 'https://www.strava.com/activities/1');
  const miles = runRecord(activity(2, 'Run', '2026-10-12T12:00:00Z', { distance: '3.00', short_unit: 'mi' }));
  assert.equal(miles.averagePace.display, '8:20 /mi');
});

test('handles zero-distance runs and refuses non-runs or invalid dates', () => {
  assert.equal(runRecord(activity(1, 'Run', '2026-10-12T12:00:00Z', { distance: '0' })).averagePace, null);
  assert.throws(() => runRecord(activity(1, 'WeightTraining', '2026-10-12T12:00:00Z')), /Only running/);
  assert.throws(() => selectLatestRuns([activity(1, 'Run', 'invalid')]), /valid start time/);
});

function fakeHistory(pages, status = 200) {
  let resolveResponse;
  let index = 0;
  const page = {
    navigationCount: 0,
    evaluate: async () => 'https://www.strava.com/athlete/training',
    waitForResponse: (predicate) => new Promise(resolve => {
      resolveResponse = () => {
        const body = pages[index++];
        const response = {
          url: () => 'https://www.strava.com/athlete/training_activities?page=' + index,
          ok: () => status === 200, status: () => status, json: async () => body,
        };
        assert.equal(predicate(response), true);
        resolve(response);
      };
    }),
    goto: async (url) => {
      assert.equal(url, 'https://www.strava.com/athlete/training');
      page.navigationCount += 1;
      resolveResponse();
    },
    waitForFunction: async () => ({ asElement: () => ({ next: true }) }),
  };
  return {
    page,
    pause: async () => {},
    clickAndPause: async () => {
      page.navigationCount += 1;
      resolveResponse();
    },
  };
}

test('continues past a page of Hevy workouts to collect older runs from My Activities', async () => {
  const history = fakeHistory([
    { page: 1, total: 3, models: [activity(3, 'WeightTraining', '2026-10-15T12:00:00Z')] },
    { page: 2, total: 3, models: [activity(2, 'Run', '2026-10-14T12:00:00Z'), activity(1, 'TrailRun', '2026-10-13T12:00:00Z')] },
  ]);
  const runs = await scrapeLatestRuns(history.page, { ...history, limit: 2 });
  assert.deepEqual(runs.map(run => run.id), ['2', '1']);
  assert.equal(history.page.navigationCount, 2);
});

test('refuses HTTP 429 without retrying the history request', async () => {
  const history = fakeHistory([{}], 429);
  await assert.rejects(scrapeLatestRuns(history.page, history), /HTTP 429/);
  assert.equal(history.page.navigationCount, 1);
});

test('refuses unsorted history rather than exporting the wrong latest runs', async () => {
  const history = fakeHistory([{ page: 1, total: 2, models: [
    activity(1, 'Run', '2026-10-12T12:00:00Z'),
    activity(2, 'Run', '2026-10-13T12:00:00Z'),
  ] }]);
  await assert.rejects(scrapeLatestRuns(history.page, history), /not sorted newest first/);
});

import puppeteer from 'puppeteer';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { scrapeHevyWorkouts } from './scrape-workouts.mjs';

try {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
for (const key of ['HEVY_EMAIL', 'HEVY_PASSWORD']) {
  if (!process.env[key]) throw new Error(`${key} is missing. Set it in the root .env file or environment.`);
}
const timeZone = process.env.HEVY_TIMEZONE ?? 'America/Toronto';
new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date());

const browser = await puppeteer.launch({
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH } : { channel: 'chrome' }),
  headless: process.env.HEVY_HEADLESS === 'true',
  defaultViewport: { width: 1440, height: 1050 },
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(30_000);
  page.setDefaultNavigationTimeout(60_000);
  const result = await scrapeHevyWorkouts(page, {
    email: process.env.HEVY_EMAIL, password: process.env.HEVY_PASSWORD, timeZone,
  });
  const directory = new URL('./output/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = new URL('latest-workouts.json.tmp', directory);
  const output = new URL('latest-workouts.json', directory);
  await writeFile(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, output);
  console.table(result.workouts.map(workout => ({
    Date: workout.date, Time: workout.time ?? '', Workout: workout.title ?? '',
    Detail: workout.detailLevel === 'full' ? 'Full' : 'Date/time only',
    Duration: workout.duration?.display ?? '', Sets: workout.setCount ?? '',
    Volume: workout.volume?.display ?? '',
    Records: workout.recordCount ?? '', 'Avg BPM': workout.averageHeartRateBpm ?? '',
  })));
  console.log(`Saved ${result.count} workouts (${result.detailedCount} full, ${result.summaryCount} summaries) to ${fileURLToPath(output)}`);
} catch (error) {
  console.error(`Hevy scrape stopped: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}

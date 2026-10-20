import puppeteer from 'puppeteer';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { scrapeLatestRuns } from './scrape-runs.mjs';
import { enrichRuns } from './enrich-runs.mjs';
import { findVisibleLoginControl, clickLoginControl } from './login-controls.mjs';

// Resolve paths relative to this script, regardless of the working directory.
const envPath = fileURLToPath(new URL('../../.env', import.meta.url));
try {
  loadEnvFile(envPath);
} catch (error) {
  // Also allow credentials supplied directly through the environment.
  if (error.code !== 'ENOENT') throw error;
}

const email = process.env.STRAVA_EMAIL;
const password = process.env.STRAVA_PASSWORD;
const athleteId = process.env.STRAVA_ATHLETE_ID;

for (const key of ['STRAVA_EMAIL', 'STRAVA_PASSWORD', 'STRAVA_ATHLETE_ID']) {
  if (!process.env[key]) {
    throw new Error(`${key} is missing. Set it in the root .env file or environment.`);
  }
}

// Puppeteer creates a temporary profile and removes it when the browser closes.
const browser = await puppeteer.launch({
  headless: process.env.STRAVA_HEADLESS === 'true',
  timeout: 0,
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--disable-blink-features=AutomationControlled'],
  defaultViewport: { width: 1920, height: 1080 },
});

class LoginRejectedError extends Error {}

// Strava renders separate desktop/mobile forms; use the visible control.
async function visibleElement(page, selector, text, acceptPasswordInput = false) {
  const handle = await page.waitForFunction(
    findVisibleLoginControl,
    { timeout: 0 },
    selector,
    text,
    acceptPasswordInput,
  );
  const element = handle.asElement();
  if (!element) {
    await handle.dispose();
    throw new LoginRejectedError('Strava rejected the unattended login. Check the Login response status above.');
  }
  return element;
}

const submitSelector = '#desktop-login-button, #mobile-login-button, #login-button, '
  + 'form button[type="submit"], form input[type="submit"]';

const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const pause = (min = 200, max = 400) => delay(randomBetween(min, max));
const pointer = { x: 0, y: 0 };

async function clickAndPause(page, element) {
  // Visibility alone doesn't mean the form is ready to accept a click.
  await page.waitForFunction(
    (element) => !element.matches(':disabled')
      && element.getAttribute('aria-disabled') !== 'true',
    { timeout: 0 },
    element,
  );
  await element.scrollIntoView();
  const target = await element.clickablePoint();
  const start = { ...pointer };
  const control = {
    x: (start.x + target.x) / 2 + randomBetween(-40, 40),
    y: (start.y + target.y) / 2 + randomBetween(-40, 40),
  };
  const steps = randomBetween(10, 16);
  const viewport = page.viewport();
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const t = progress * progress * (3 - 2 * progress);
    const x = (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t ** 2 * target.x;
    const y = (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t ** 2 * target.y;
    await page.mouse.move(
      Math.max(0, Math.min(viewport.width - 1, x)),
      Math.max(0, Math.min(viewport.height - 1, y)),
    );
    await delay(randomBetween(3, 8));
  }
  Object.assign(pointer, target);
  await pause(40, 100);
  await clickLoginControl(element, randomBetween(40, 80));
  await pause();
}

async function typeAndPause(page, element, value) {
  await clickAndPause(page, element);
  // Select and replace existing text without rapidly triple-clicking the field.
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(modifier);
  try {
    await page.keyboard.press('KeyA', { delay: randomBetween(30, 60) });
  } finally {
    await page.keyboard.up(modifier);
  }
  await pause();
  await element.press('Backspace');
  await pause();
  for (const character of value) {
    await page.keyboard.type(character, { delay: randomBetween(20, 50) });
  }
  await pause(250, 450);
}

async function waitForSignedIn(page) {
  const result = await page.waitForFunction(() => {
    if (location.hostname === 'www.strava.com'
      && /^\/(dashboard|athletes\/\d+)(\/|$)/.test(location.pathname)) {
      return 'signed-in';
    }
    if (/An unexpected error occurred/i.test(document.body?.innerText || '')) {
      return 'rejected';
    }
    return false;
  }, { timeout: 0 });
  const state = await result.jsonValue();
  await result.dispose();
  if (state === 'rejected') {
    throw new LoginRejectedError('Strava rejected the unattended login. Check the Login response status above.');
  }
}

let stage = 'opening Strava';
let lastLoginResponse = null;

try {
  const page = await browser.newPage();
  // Keep navigation and element waits unlimited.
  page.setDefaultTimeout(0);
  page.setDefaultNavigationTimeout(0);
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.hostname === 'www.strava.com'
      && (url.pathname.startsWith('/login') || url.pathname === '/session')
      && response.request().method() === 'POST') {
      // Never log credentials, query parameters, headers, or response bodies.
      lastLoginResponse = { status: response.status(), path: url.pathname };
      console.log('Login response:', response.status(), url.pathname);
    }
  });
  await page.goto('https://www.strava.com/', { waitUntil: 'domcontentloaded' });
  await pause(600, 1_000);

  // The cookie banner is optional; don't wait indefinitely if it is absent.
  const declineCookies = await page.$('#CybotCookiebotDialogBodyButtonDecline');
  if (declineCookies && await declineCookies.isVisible()) {
    await clickAndPause(page, declineCookies);
  }

  if (new URL(page.url()).pathname === '/') {
    stage = 'opening the login page';
    const loginButton = await visibleElement(page, 'button', 'Log In');
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      clickAndPause(page, loginButton),
    ]);
    if (!new URL(page.url()).pathname.startsWith('/login')) {
      throw new Error('The homepage Log In button did not open the login page.');
    }
  }

  // Sign in using .env credentials for this fresh browser session.
  if (new URL(page.url()).pathname.startsWith('/login')) {
    stage = 'entering the email';
    await pause(300, 600);
    const emailInput = await visibleElement(page, 'input[name="email"], input[type="email"]');
    await typeAndPause(page, emailInput, email);

    const passwordVisible = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input[type="password"]')).some(
        (element) => element.getClientRects().length > 0,
      ),
    );
    if (!passwordVisible) {
      // Submit the email, then switch from the code flow to password login.
      stage = 'submitting the email';
      await clickAndPause(page, await visibleElement(page, submitSelector));
      stage = 'opening password login';
      const passwordStep = await visibleElement(
        page, 'button, a, [role="button"]', 'Use password instead', true,
      );
      const passwordAlreadyOpen = await passwordStep.evaluate(element => element.matches('input[type="password"]'));
      if (!passwordAlreadyOpen) {
        console.log('Clicking Use password instead.');
        await clickAndPause(page, passwordStep);
      }
      await passwordStep.dispose();
    }

    stage = 'entering the password';
    const passwordInput = await visibleElement(page, 'input[type="password"]');
    console.log('Password field is ready.');
    await typeAndPause(page, passwordInput, password);
    stage = 'submitting the password';
    await clickAndPause(page, await visibleElement(page, submitSelector));

    stage = 'waiting for Strava to confirm login';
    await waitForSignedIn(page);
    console.log('Login confirmed. Opening your athlete page.');
  }

  stage = 'opening the athlete page';
  await page.goto(`https://www.strava.com/athletes/${encodeURIComponent(athleteId)}`, {
    waitUntil: 'domcontentloaded',
  });
  if (new URL(page.url()).pathname !== `/athletes/${athleteId}`) {
    throw new Error('Strava did not open the requested athlete page after login.');
  }

  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  stage = 'scraping your latest five runs';
  console.log('Reading your own activity history.');
  const summaries = await scrapeLatestRuns(page, {
    limit: 5, clickAndPause, pause: () => pause(1_000, 1_800),
  });
  const outputDirectory = new URL('./output/', import.meta.url);
  stage = 'collecting run metrics, uploaded photos, and route images';
  const runs = await enrichRuns(page, summaries, {
    athleteId, outputDirectory, pause: () => pause(1_000, 1_800),
  });
  stage = 'saving the run data';
  const outputPath = new URL('latest-runs.json', outputDirectory);
  const temporaryPath = new URL('latest-runs.json.tmp', outputDirectory);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify({
    athleteId,
    scrapedAt: new Date().toISOString(),
    source: 'https://www.strava.com/athlete/training',
    count: runs.length,
    runs,
  }, null, 2)}\n`);
  await rename(temporaryPath, outputPath);
  console.table(runs.map(run => ({
    Date: run.dateLabel,
    Run: run.name,
    Sport: run.sportType,
    Distance: `${run.distance.value} ${run.distance.unit}`,
    'Moving time': run.movingTime.display,
    'Pace /km': run.averagePacePerKm?.display || 'Unavailable',
    'Avg HR': run.averageHeartRateBpm ?? 'Unavailable',
    Effort: run.relativeEffort ?? 'Unavailable',
    'Elevation (m)': run.elevationGainMeters ?? 'Unavailable',
    Photos: run.photos.length,
    Route: run.routeImage ? 'Saved' : 'Unavailable',
    Map: run.mapImage ? 'Saved' : 'Unavailable',
  })));
  console.log(`Saved ${runs.length} runs to ${fileURLToPath(outputPath)}`);
  if (runs.length < 5) console.log('Your activity history contains fewer than five running activities.');
} catch (error) {
  console.error(`Stopped during ${stage}: ${error.message}`);
  if (lastLoginResponse) {
    console.error('Last login response:', lastLoginResponse.status, lastLoginResponse.path);
  }
  throw error;
} finally {
  await browser.close();
}

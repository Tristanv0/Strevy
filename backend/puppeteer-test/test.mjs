import puppeteer from 'puppeteer';

const athleteId = process.env.STRAVA_ATHLETE_ID;

// launch the browser
const browser = await puppeteer.launch({
    headless: false,
    userDataDir: './browser-profile',
});

// create a new page and navigate to the Strava login page
const page = await browser.newPage();

// await page.goto('https://strava.com/login');
if (!athleteId) {
  throw new Error('STRAVA_ATHLETE_ID is missing from .env');
}
await page.goto(`https://www.strava.com/athletes/${athleteId}`, {
  waitUntil: 'domcontentloaded',
});
await page.setViewport({ width: 1920, height: 1080 });

console.log('Current URL:', page.url());
console.log('Page title:', await page.title());

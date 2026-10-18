# Strevy
Tired of paying to see your data on Strava and Hevy? This app will soon combine your workouts from both apps and provide data from the start to view your data for FREE!

## Strava run scraper

Requires Node.js 22.15+ and Google Chrome. Set `STRAVA_EMAIL`, `STRAVA_PASSWORD`, and `STRAVA_ATHLETE_ID` in the root `.env` file. Quote values containing `#`.

From the project root:

```sh
npm --prefix backend/puppeteer-test ci
node backend/puppeteer-test/test.mjs
```

The script logs in automatically and reads **My Activities**, which is scoped to the signed-in account. It selects the five newest activities whose sport is `Run`, `TrailRun`, or `VirtualRun`, paging through older activities if necessary. Weight training, walks, rides, and other sports are excluded regardless of their titles.

Results are saved to `backend/puppeteer-test/output/latest-runs.json` and summarized in the terminal. Each run contains its ID, title, sport, start time, distance and units, moving and elapsed time, elevation gain, relative effort, description, and Strava URL. Pace is calculated from moving time and the displayed distance, so it reflects Strava's distance rounding. Unavailable values are `null`; heart rate and calories are not included because they are not supplied by the inspected activity-history response.

The output folder is gitignored. Each execution uses a temporary browser profile and closes the browser after exporting. Navigation and element waits remain unlimited.

Offline tests (no login or Strava requests):

```sh
npm --prefix backend/puppeteer-test test
```

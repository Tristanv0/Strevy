# Strevy
An API for bringing Strava runs and Hevy workouts together. The API exposes saved Strava runs and media, plus Hevy workouts.

## Express API

Requires Node.js 22.15+. From the repository root:

```sh
npm ci
npm run dev
```

The server runs at `http://127.0.0.1:3001`. `npm run dev` restarts it when server source files change; use `npm start` to run without watching.

Available endpoints:

- `GET /` returns `{ "name": "Strevy API" }`.
- `GET /health` returns `{ "status": "ok" }`. This checks that the API is responding, not whether a scrape succeeded.
- `GET /api/runs` returns the latest saved `latest-runs.json` snapshot, with a `url` added to each stored image entry. It reads the snapshot from local disk or R2 on every request, so updated data is available without restarting the server. It returns HTTP 503 if no snapshot exists yet.
- `GET /api/runs/media/<activity-id>/route.png` serves the transparent route-only image; `map.png` in the same folder serves the route with Strava's map background. Existing local photo files can also be served from this media folder. Missing files return a JSON 404 response; directory listings are disabled.
- `GET /api/workouts` returns the complete saved Hevy report from `scrapers/hevy/output/latest-workouts.json` locally or `hevy/latest-workouts.json` in R2. It includes the latest five full workouts and current-month title/date/time summaries. The endpoint reads the file on every request, uses `Cache-Control: no-store`, and returns HTTP 503 when no snapshot exists yet.
- Unrecognized endpoints return a JSON 404 response.

Optionally set `PORT` and `HOST` in the root `.env` or environment. For a deployment that needs to accept connections on all interfaces, set `HOST=0.0.0.0` and use the port provided by your host.

The runs and workouts endpoints return their saved reports without authentication. Browser access is controlled by the comma-separated `ALLOWED_ORIGINS` setting; the local Node server defaults to localhost ports 3000 and 5173. API requests read saved data. A separate Cloudflare workflow refreshes Hevy on the nightly schedule below.

Local image URLs in the response are relative to the API origin, for example `/api/runs/media/123/route.png`. Uploaded photo URLs remain unchanged. A website on another origin should resolve a local image URL against the API origin:

```js
const apiOrigin = 'http://localhost:3001';
const response = await fetch(`${apiOrigin}/api/runs`);
if (!response.ok) throw new Error('Could not load runs');
const data = await response.json();
const routeImageUrl = data.runs[0]?.routeImage?.url;
const imageSrc = routeImageUrl ? new URL(routeImageUrl, apiOrigin).href : null;
```

The JSON response contains image URLs; image bytes are fetched separately using those URLs. The saved JSON file is not modified by API requests.

Fetch Hevy workouts from your frontend in the same way:

```js
const response = await fetch('https://api.tristancheng.com/api/workouts');
if (!response.ok) throw new Error('Could not load workouts');
const { workouts, scrapedAt, period } = await response.json();
```

## Cloudflare Workers and R2

Cloudflare deployment is configured for `api.tristancheng.com`. See the
[setup guide](docs/cloudflare.md) for account setup, R2 bucket creation, uploads,
deployment, and website integration.

The [nightly Hevy workflow](docs/cloudflare.md#nightly-hevy-refresh) uses Cloudflare
Cron Triggers at **11:59 p.m. Toronto time**, including daylight-saving changes:
scrape Hevy → update `hevy/latest-workouts.json` in R2 → trigger the frontend's
Workers Builds deploy hook. Strava scraping continues to run locally.

```sh
npm run secrets:hevy     # Upload the three automation secrets from .env
npm run deploy          # Deploy the API, workflow, and cron configuration
npm run refresh:hevy    # Start an additional cloud refresh now
npm run test:automation # Check scheduling and pipeline failure handling
```

```sh
npm run upload:r2 -- --local --source strava  # Replace local R2 Strava data
npm run dev:worker             # Run the Worker locally on port 8787
npm run upload:r2 -- --remote --source strava  # Replace only strava/
npm run upload:r2 -- --remote --source hevy    # Replace only hevy/
npm run upload:r2 -- --remote --source all     # Replace both source folders
npm run deploy                # Publish the Worker and custom domain
```

The private `strevy-data` bucket stores JSON and images. The Worker uses its R2
binding without needing Strava credentials. The scraper runs separately from the
Worker, locally or in the manual GitHub Actions test described below. Both local
and remote uploads validate and stage the selected output directories before
deleting objects. Each upload replaces only the selected `strava/` or `hevy/`
prefix in R2, then publishes JSON after all files. The default source is `strava`;
`--replace` is still accepted but is no longer needed. Use `--dry-run` to preview
without contacting R2. Run one upload at a time; replacement is not atomic.

The Worker reads Strava objects under `strava/` and Hevy JSON under `hevy/`; API image URLs stay the same.
For an existing deployment, upload Strava with the new script and redeploy the
Worker to switch storage paths. Legacy objects at the bucket root are retained
and can be removed separately after checking the updated API.

## Repository layout

```text
src/
  app.js             Shared Express application factory and middleware
  server.js          Local Node listener using disk storage
  worker.js          Cloudflare Workers entry point using R2
  routes/health.js   Health endpoint
  routes/runs.js     Saved runs and associated media
  routes/workouts.js Saved Hevy workout report
  storage/           Local-disk and R2 storage adapters
scripts/
  upload-r2.mjs      Replace selected Strava/Hevy R2 folders with local output
docs/cloudflare.md   Cloudflare setup and deployment instructions
wrangler.jsonc       Worker, domain, CORS origins, and R2 binding
scrapers/
  strava/            Puppeteer scraper and helpers
    output/          Saved JSON and generated route images (gitignored)
  hevy/              Latest five full workouts and current-month summaries
    output/          latest-workouts.json (gitignored)
package.json         Shared dependencies and commands
```

The repository contains only a backend, so there is no additional `backend/` wrapper. The scraper's existing output was moved with its code; relative image paths inside the JSON still work.

## Strava run scraper

Requires Node.js 22.15+ and Puppeteer's downloaded Chrome (installed by `npm ci`),
or a browser selected using `PUPPETEER_EXECUTABLE_PATH`. Set `STRAVA_EMAIL`,
`STRAVA_PASSWORD`, and `STRAVA_ATHLETE_ID` in the root `.env` file. Quote values
containing `#`.

From the project root:

```sh
npm run scrape:strava
```

The script logs in automatically and reads **My Activities**, which is scoped to the signed-in account. It selects the five newest activities whose sport is `Run`, `TrailRun`, or `VirtualRun`, paging through older activities if necessary. Weight training, walks, rides, and other sports are excluded regardless of their titles.

Results are saved to `scrapers/strava/output/latest-runs.json` and summarized in the terminal. Each run contains its ID, title, sport, start time, distance and units, moving and elapsed time, elevation gain, relative effort, description, and Strava URL. The scraper then opens each of those five run pages, verifies that it belongs to the signed-in athlete, and adds:

- `averageHeartRateBpm`, when recorded and available.
- `calories`, in kcal, read from the activity's data or displayed calorie statistic. Missing or invalid values are `null`; calories are not calculated by the scraper.
- `averagePacePerKm`, calculated from Strava's precise average speed or distance and moving time. The original `averagePace` field retains the activity-history display units and rounding.
- `distanceMeters` and `elevationGainMeters`, using precise activity values when available.
- `photos`, containing `{ "id": "...", "url": "https://..." }` entries for the athlete's own uploaded photos attached to that run. The scraper stores the original image URLs without downloading or re-encoding photos. These remote URLs may change or expire; the linked images retain any original metadata.
- `routeImage`, referencing a transparent PNG containing only the route line. No map tiles, street names, landmarks, start/end markers, raw GPS coordinates, or geographic metadata are exported. Strava's privacy-hidden samples are omitted without connecting across those gaps; routes without a matching privacy mask are not exported.
- `mapImage`, containing the original static map image `url` from the athlete feed's `img[data-testid="map"]`, plus its dimensions when available, `containsBasemap: true`, and `source: "strava-feed-map"`. The scraper matches the image's enclosing activity link to the run ID and attaches it only after verifying activity ownership. Like uploaded photos, this stores the URL without downloading, re-encoding, or taking a screenshot. After opening the profile, it spends up to 20 seconds scanning lazy-loaded entries and following the profile's existing week links for older runs; missing map URLs produce `null` and a `mediaWarnings` entry. This image includes the map background and route as provided by Strava, and its URL can change or expire.

Generated transparent route PNGs are saved under `output/media/<activity-id>/`, with paths in JSON relative to the output folder. Photos and static maps use remote URLs; new scrapes do not create `map.png`. Each scrape deletes and recreates the local output directory after login and activity selection succeed, removing older snapshots, images, and temporary files before exporting. A later extraction failure can leave partial output. This cleanup does not delete objects from R2. Unavailable metrics are `null`, missing photos produce an empty array, and optional media failures are recorded in `mediaWarnings`. A route shape, map, or uploaded photo can still identify a location. The JSON also retains activity titles, descriptions, and Strava URLs, so do not treat the entire report as anonymous.

The output folder is gitignored. Each execution uses a temporary browser profile and closes the browser after exporting. Navigation and element waits remain unlimited.

## Hevy workout scraper

Set `HEVY_EMAIL` and `HEVY_PASSWORD` in the root `.env` file, then run from the
repository root:

```sh
npm run scrape:hevy
```

The scraper uses Puppeteer to log in at `https://hevy.com/login`, then reads your
own profile's workout responses while scrolling its history. It verifies the
signed-in account against every workout owner and ignores the social feed.
No Hevy Pro API key is needed.

The export always includes the latest five workouts, even when they fall in a
previous month. Additional summaries cover only the current calendar month,
from the first day at local midnight through the time the scrape starts.
`period.start` and `period.end` record that summary window as UTC timestamps;
the five full workouts can fall before `period.start`. Dates, summary times,
and the month boundary use `America/Toronto` by default; set `HEVY_TIMEZONE`
to another IANA timezone if needed.

Results are saved to `scrapers/hevy/output/latest-workouts.json`, newest first:

- The latest five workouts **across your history** contain exercises and every
  set, including warmups, reps, weight, RPE, duration/distance when recorded,
  superset IDs, notes, start/end times, total duration, volume, personal and
  yearly records, and average BPM when available. Calories are included when
  recorded. Missing metrics stay `null`; no heart rate is guessed.
- Remaining workouts **in the current calendar month** contain `title`, `date`
  (`YYYY-MM-DD`) and `time` (`HH:mm:ss`, 24-hour local start time). Workouts
  already included in the latest five are not duplicated as summaries.

Exercises retain their sequence from Hevy's workout response, with an explicit
`order` field starting at 1. Exercise `priority` does not determine the exported
sequence. Sets remain sorted by Hevy's set index and numbered from 1.

Each full workout includes `photos: [{ "url": "https://..." }]` for images
attached to that workout, or `photos: []` when none are available. The scraper
reads Hevy's `media` images and `image_urls`, removes duplicate URLs, and excludes
profile pictures and videos. Images remain remote URLs; they are not downloaded
to disk or R2. These URLs are included in `/api/workouts` after uploading the
updated JSON and may change or expire. Summary workouts have no `photos` field.

For example, on October 2 the full workouts can extend into September, with
extra summaries only for October 1–2. With one workout each day October 1–7,
an October 8 scrape exports October 3–7 in full and October 1–2 as summaries.

Weights and volume include canonical kilograms and converted display values
using your Hevy unit preference. Display duration rounds to the nearest minute,
while `duration.seconds` retains the precise interval. Volume uses Hevy's
reported `estimated_volume_kg`, retaining its warmup-inclusion flag; it is not
recalculated from sets. Records preserve Hevy's metric types and values and are
attached to their exercise and set. Raw heart-rate samples, GPS data, account
email, credentials, and session tokens are not exported.

Each successful scrape atomically replaces the previous JSON. A failed or
incomplete history read leaves the previous export intact. The browser uses a
temporary profile and closes afterward; no browser profile is saved. Chrome
must be installed, or set `PUPPETEER_EXECUTABLE_PATH`. Set `HEVY_HEADLESS=true`
to request headless mode; the verified default runs with a visible browser.

Hevy output is gitignored. Upload it to R2 with
`npm run upload:r2 -- --remote --source hevy`, or upload both sources with
`npm run upload:r2 -- --remote --source all`. Fetch the saved report through
`GET /api/workouts`. The manual Strava GitHub Actions workflow does not scrape
Hevy workouts.

## Test Strava scraper on GitHub Actions

The manual [Test Strava scrape workflow](.github/workflows/test-strava-scrape.yml)
runs Chrome in headed mode inside Xvfb, a virtual display on Ubuntu. It sets
`STRAVA_HEADLESS=false`; set this variable to `true` only when explicitly testing
headless Chrome. The runner provides Chrome and Xvfb, so the workflow uses that
Chrome installation instead of downloading another browser.

1. In the **Strevy** GitHub repository, open **Settings → Secrets and variables →
   Actions → New repository secret**. Add `STRAVA_EMAIL`, `STRAVA_PASSWORD`, and
   `STRAVA_ATHLETE_ID`, using the same values as your local `.env`.
2. Commit and push the workflow, this documentation, and your scraper's
   `STRAVA_HEADLESS` change to the repository's default branch. Keep `.env` and
   the output directory gitignored. GitHub needs `workflow_dispatch` workflows
   on the default branch before the manual run button is available.
3. Open **Actions → Test Strava scrape → Run workflow**, select the branch, and
   click **Run workflow**. If prompted, enable Actions for the repository.
4. Open the run and inspect the **Scrape with a virtual display** and **Verify
   route and map exports** logs. The verification also adds a table to the run
   summary and fails if any exported run lacks a valid route PNG or an accessible
   static map image URL. Older snapshots with local map PNGs are also accepted.
5. Download **strava-scrape-output** from the run's **Artifacts** section to view
   `latest-runs.json` and `media/<activity-id>/route.png`. Open the `mapImage.url`
   from the JSON in a browser to inspect the original static map. Confirm that
   it contains the expected route and background; file/HTTP checks alone cannot
   verify image content.

This test expects GPS media for every returned run. An activity that genuinely
has no GPS route can fail that check even if browser rendering works. Output is
retained for three days and is uploaded for inspection even after a verification
failure, when files exist. Only the generated JSON and local PNGs are included;
remote maps and photos remain URLs in that JSON.

The scrape step has a ten-minute limit because the scraper's own element waits
are currently unlimited. If it times out, inspect its last logged stage. A
successful local login does not establish that Strava will accept login from a
GitHub runner.

This workflow runs only when manually triggered. It does not upload to R2,
deploy the API, or update the portfolio. No Cloudflare secrets are needed for
this test. See GitHub's guides for
[repository secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
and [manual runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

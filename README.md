# Strevy
An API for bringing Strava runs and Hevy workouts together. Saved Strava runs and route images are available through the API; Hevy integration will be added next.

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
- `GET /api/runs` returns the latest saved `latest-runs.json` snapshot, with a `url` added to each locally stored image entry. It reads the file on each request, so a completed scrape is available without restarting the server. It returns HTTP 503 if no snapshot exists yet.
- `GET /api/runs/media/<activity-id>/route.png` serves the transparent route-only image; `map.png` in the same folder serves the route with Strava's map background. Existing local photo files can also be served from this media folder. Missing files return a JSON 404 response; directory listings are disabled.
- Unrecognized endpoints return a JSON 404 response.

Optionally set `PORT` and `HOST` in the root `.env` or environment. For a deployment that needs to accept connections on all interfaces, set `HOST=0.0.0.0` and use the port provided by your host.

The API server does not launch Chrome or run the scraper. The runs endpoint returns the saved report, including its activity details and photo URLs, without authentication. CORS and scheduled scraping are not configured yet.

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

## Repository layout

```text
src/
  app.js             Express application and middleware
  server.js          Environment loading and HTTP listener
  routes/health.js   Health endpoint
  routes/runs.js     Saved runs and associated media
scrapers/
  strava/            Puppeteer scraper and helpers
    output/          Saved JSON and generated route images (gitignored)
package.json         Shared dependencies and commands
```

The repository contains only a backend, so there is no additional `backend/` wrapper. The scraper's existing output was moved with its code; relative image paths inside the JSON still work.

## Strava run scraper

Requires Node.js 22.15+ and Google Chrome. Set `STRAVA_EMAIL`, `STRAVA_PASSWORD`, and `STRAVA_ATHLETE_ID` in the root `.env` file. Quote values containing `#`.

From the project root:

```sh
npm run scrape:strava
```

The script logs in automatically and reads **My Activities**, which is scoped to the signed-in account. It selects the five newest activities whose sport is `Run`, `TrailRun`, or `VirtualRun`, paging through older activities if necessary. Weight training, walks, rides, and other sports are excluded regardless of their titles.

Results are saved to `scrapers/strava/output/latest-runs.json` and summarized in the terminal. Each run contains its ID, title, sport, start time, distance and units, moving and elapsed time, elevation gain, relative effort, description, and Strava URL. The scraper then opens each of those five run pages, verifies that it belongs to the signed-in athlete, and adds:

- `averageHeartRateBpm`, when recorded and available.
- `averagePacePerKm`, calculated from Strava's precise average speed or distance and moving time. The original `averagePace` field retains the activity-history display units and rounding.
- `distanceMeters` and `elevationGainMeters`, using precise activity values when available.
- `photos`, containing `{ "id": "...", "url": "https://..." }` entries for the athlete's own uploaded photos attached to that run. The scraper stores the original image URLs without downloading or re-encoding photos. These remote URLs may change or expire; the linked images retain any original metadata.
- `routeImage`, referencing a transparent PNG containing only the route line. No map tiles, street names, landmarks, start/end markers, raw GPS coordinates, or geographic metadata are exported. Strava's privacy-hidden samples are omitted without connecting across those gaps; routes without a matching privacy mask are not exported.
- `mapImage`, referencing a separate `map.png` screenshot of the map displayed on the signed-in activity page, including its route, geographic background, and visible map attribution. This image can show street names and identifiable locations. It is separate from `routeImage`; when the rendered map is unavailable, this field is `null` and `mediaWarnings` explains the missing export. An uninitialized map is retried once by reopening the activity and checking ownership again.

Generated route PNGs are saved under `output/media/<activity-id>/`, with paths in JSON relative to the output folder. Existing downloaded photos from earlier runs are left in place, but future scrapes do not create photo files. Unavailable metrics are `null`, missing photos produce an empty array, and optional media failures are recorded in `mediaWarnings`. A route shape or an uploaded photo can still identify a location. The JSON also retains activity titles, descriptions, and Strava URLs, so do not treat the entire report as anonymous.

The output folder is gitignored. Each execution uses a temporary browser profile and closes the browser after exporting. Navigation and element waits remain unlimited.

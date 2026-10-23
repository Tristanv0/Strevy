# Deploy Strevy to Cloudflare Workers and R2

The API runs at `https://api.tristancheng.com`. Its private R2 bucket stores the
Strava and Hevy output in separate prefixes. The Worker serves `/api/runs`,
`/api/runs/media/...`, and `/api/workouts`. There is no database to create.

This setup uses Cloudflare's [Express integration](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)
and [R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
The Strava scraper runs on your computer. The Hevy scraper also runs in a separate
Cloudflare Workflow on the nightly schedule described below.

## 1. Test the Worker locally

From the repository root, install dependencies if needed:

```sh
npm ci
```

If you do not already have `.dev.vars`, create it from the example:

```sh
cp .dev.vars.example .dev.vars
```

This file configures browser origins for local testing. It also prevents Wrangler
from loading the scraper's `.env`. The Worker does not need Strava credentials.

Load your existing scraper output into the local R2 emulator:

```sh
npm run upload:r2 -- --local --source all
npm run dev:worker
```

Open `http://localhost:8787/health`, `http://localhost:8787/api/runs`, and
`http://localhost:8787/api/workouts`. The runs image URLs work on the same host. Local R2
data is kept in `.wrangler/state/` and is separate from your Cloudflare bucket.
These commands do not require creating a cloud bucket or publishing the API.

Your original local Node server is also available via `npm run dev` at port 3001.
It reads the scraper's output directly from disk; it does not use the emulator.

## 2. Enable R2 and log in

In the Cloudflare dashboard, open **Storage & databases → R2** and enable R2 for
the account containing `tristancheng.com`. R2 activation involves a subscription
checkout; usage within the free allowance is included, and overages are billable.
See [R2 setup](https://developers.cloudflare.com/r2/get-started/) and
[pricing](https://developers.cloudflare.com/r2/pricing/).

Then authenticate Wrangler:

```sh
npx wrangler login
```

Complete the browser authorization with that Cloudflare account. If you have
multiple accounts, use `npx wrangler whoami` and set `account_id` in
`wrangler.jsonc` to the account that owns your domain and bucket.

## 3. Create the private bucket

```sh
npx wrangler r2 bucket create strevy-data
```

If it already exists in the intended account, skip creation. The binding is
already configured in `wrangler.jsonc`:

```json
"r2_buckets": [
  { "binding": "STREVY_DATA", "bucket_name": "strevy-data" }
]
```

Keep the bucket private. You do not need to enable an R2 public development URL
or attach a public domain to the bucket; the API serves the objects.

If you choose another bucket name, update `bucket_name` and pass
`--bucket YOUR_BUCKET` to the upload command.

## 4. Upload Strava, Hevy, or both

Preview the objects first if desired:

```sh
npm run upload:r2 -- --remote --source all --dry-run
```

Upload either source separately or both together:

```sh
npm run upload:r2 -- --remote --source strava
npm run upload:r2 -- --remote --source hevy
npm run upload:r2 -- --remote --source all
```

Each command replaces only its selected source folders in R2 with all regular
files from the corresponding `scrapers/<source>/output/` directories. Strava
uploads leave `hevy/` intact; Hevy uploads leave `strava/` intact; `all` replaces
both. Other bucket objects are never deleted. The default source is `strava`.

The bucket layout is:

```text
strava/latest-runs.json
strava/media/<activity-id>/route.png
strava/media/<activity-id>/map.png
hevy/latest-workouts.json
```

New scrapes store the static Strava map in `mapImage.url`, like uploaded photos.
Those remote images are referenced in the JSON and are not downloaded to R2.
The `map.png` layout above remains supported for older screenshot-based exports.

Use `--remote` explicitly for cloud uploads. Without it, the upload command uses
the local emulator. `--replace` remains accepted for older commands, but all
uploads now replace the selected source folders automatically. Local files no
longer referenced by a snapshot are still uploaded if they remain in its output
directory. `--directory PATH` overrides the output directory for a single source;
it cannot be combined with `--source all`.

The script validates both snapshots when uploading `all`, validates Strava's
referenced PNGs, and stages every file before any deletion. It rejects symlinks
and unfinished `.tmp` files. For each selected prefix, it lists all pages before
deleting in batches of up to 1,000. Listing/deletion uses Wrangler's R2 binding
and the same Cloudflare login; no separate S3 access keys are required. Media and
other files are uploaded before either selected JSON snapshot.

Replacement is not atomic: the API can return 503 while `strava/` is being
refilled. A failed upload after deletion can leave partial data; rerun the upload
after fixing the failure. Run one upload at a time. For a local-only test, use
`--local` instead of `--remote`.

### Existing deployments

The Worker now reads `strava/latest-runs.json` and `strava/media/...`. Upload
Strava using the updated script, then deploy the updated Worker. Public endpoint
paths and image URLs remain `/api/runs` and `/api/runs/media/...`.

Legacy objects such as `latest-runs.json` and `media/...` at the bucket root are
left untouched. After verifying the updated deployment, remove those separately
if desired. The workouts endpoint reads `hevy/latest-workouts.json`; upload Hevy
and deploy the updated Worker to make it available.

## 5. Deploy the API and custom domain

The configuration already declares:

- Worker name: `strevy-api`
- Entry point: `src/worker.js`
- Custom domain: `api.tristancheng.com`
- Allowed website origins: `https://tristancheng.com` and `https://www.tristancheng.com`

Deploy from the repository root:

```sh
npm run deploy
```

Cloudflare provisions the Worker custom domain when the domain is in your
account. If the `api` hostname is already used by another service, resolve that
conflict in Cloudflare before deploying. See [custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

After deployment and domain activation, visit:

- `https://api.tristancheng.com/health`
- `https://api.tristancheng.com/api/runs`
- `https://api.tristancheng.com/api/workouts`

The health check confirms the API is responding. Before a source's snapshot is
uploaded, its endpoint returns HTTP 503. Missing image objects return JSON 404.

From your website:

```js
const apiOrigin = 'https://api.tristancheng.com';
const response = await fetch(`${apiOrigin}/api/runs`);
if (!response.ok) throw new Error('Could not load runs');
const { runs } = await response.json();
const imageSrc = runs[0]?.routeImage?.url
  ? new URL(runs[0].routeImage.url, apiOrigin).href
  : null;
```

Use `mapImage.url` for the image with street names and a map background. It may
be an absolute Strava CDN URL; older local screenshots use an API-relative URL.
The GET endpoints publish the full saved report without authentication, as the
local API does. CORS permits browser reads from your configured website origins;
it does not make the API private.

## 6. Refresh your data

Run the scraper as usual:

```sh
npm run scrape:strava
```

After it succeeds, upload the new output:

```sh
npm run upload:r2 -- --remote --source strava
```

The deployed API reads R2 on every request, so it does not need redeployment when
the data changes. Your existing uploaded data stays available when your computer
is off. Hevy refreshes can run independently in Cloudflare as described below.

## Nightly Hevy refresh

Cloudflare Cron Triggers start `strevy-hevy-refresh` at **23:59 America/Toronto**.
The Worker checks the cron event's scheduled timestamp, rather than its delivery
time. The UTC cron `59 3,4 * * *` fires twice, but only the event corresponding to
23:59 in Toronto starts a workflow. This handles daylight-saving changes without
running the scraper twice. This is Toronto local time, not fixed UTC−5 year-round.

The workflow runs these steps in order:

1. Launch Cloudflare Browser Run, log into Hevy, and run the existing own-profile
   scraper. The latest five workouts retain full detail; additional workouts are
   current-month title/date/time summaries. Exercise order and photo URLs use the
   same exporter as the local command.
2. Atomically replace `hevy/latest-workouts.json` through the R2 binding. There is
   no bucket wipe or interval where the report is missing. Images stay remote
   URLs in the JSON. Other keys, including the complete `strava/` prefix, are left
   intact. Local output files are not updated by the cloud job.
3. POST the frontend's Workers Builds deploy hook. Your Astro frontend reads the
   API at build time, so a new build is needed to display the refreshed report.

### Configure the secrets and deploy

In the Cloudflare dashboard, select the **frontend** Worker for
`Tristanv0.github.io`, then open **Settings → Builds → Deploy Hooks**. Create a hook
for the production branch. Save its URL in the gitignored root `.env` alongside
your existing Hevy credentials:

```dotenv
HEVY_EMAIL="your-email"
HEVY_PASSWORD="your-password"
FRONTEND_DEPLOY_HOOK_URL="https://api.cloudflare.com/client/v4/workers/builds/deploy_hooks/YOUR_HOOK_ID"
```

The hook must belong to the frontend, not `strevy-api`. Verify the frontend's
production build variable `STREVY_API_ORIGIN` is `https://api.tristancheng.com`.
The deploy hook URL is a secret and does not need a separate Authorization header.

From the Strevy root:

```sh
npx wrangler login
npm run secrets:hevy -- --dry-run
npm run secrets:hevy
npm run deploy
```

`secrets:hevy` validates the three values and pipes only those values into
Wrangler's secret bulk command. It does not print them or upload the rest of
`.env`. These are Worker secrets; putting them only in the local `.env` is not
enough for a cloud run. No Cloudflare API token is needed by the running workflow:
it uses its Browser Run, R2, and Workflows bindings. If Wrangler reports no access
while using a browser-only `CLOUDFLARE_API_TOKEN`, remove that obsolete setting
from `.env`/your shell and use `wrangler login`, or supply a token with deployment
permissions for this Worker and workflow.

`wrangler.jsonc` declares the browser binding, workflow binding, and cron. A
deployment applies the schedule; Cloudflare can take up to 15 minutes to propagate
cron changes. The browser and workflow use your Cloudflare account's allowances
and plan limits. Your computer can be off when the scheduled cloud run starts.

### Run and inspect a refresh

After deployment, start one complete cloud run immediately:

```sh
npm run refresh:hevy
```

The command prints an instance ID. Inspect it with:

```sh
npx wrangler workflows instances describe strevy-hevy-refresh INSTANCE_ID --no-step-output
```

Or open **Workflows → strevy-hevy-refresh → Instances** in Cloudflare. The steps
are `scrape-hevy`, `publish-hevy-to-r2`, and `rebuild-frontend`. After upload,
`https://api.tristancheng.com/api/workouts` should show the new `scrapedAt`.
Inspect the frontend Worker's build history to confirm its deployment succeeds.
A completed workflow means the build hook accepted the request; the build itself
finishes asynchronously and can still fail independently.

The login/scrape step is attempted once. Scrape failures preserve the old report
and do not start a build. R2 and hook failures each receive up to three retries;
completed steps are checkpointed so those retries do not repeat the login.
A later manual workflow restart is a new execution and may log in again. Workflow
concurrency is one, repeated nightly events reuse the date's instance ID, and a
stale report cannot overwrite a newer snapshot. A hook timeout can mean the
request was accepted without its response arriving, so a retry can queue an
additional frontend build.

There is no public HTTP endpoint that starts scraping. Manual runs use your
authenticated Wrangler session. Strava has no Cloudflare login or cron path.

Local development does not fire cron automatically. `npm run test:automation`
checks the full year of Toronto schedule boundaries, pipeline ordering, R2
failure handling, checkpoint reuse, and secret-safe hook errors without logging
in or changing cloud data. `npm run dev:worker` continues serving local R2 data;
starting a local workflow requires local Hevy/hook secrets and can contact the
real websites. Use the deployed workflow for an intentional live end-to-end test.

References: [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/),
[Workflows](https://developers.cloudflare.com/workflows/build/trigger-workflows/),
[Browser Run](https://developers.cloudflare.com/browser-run/puppeteer/),
and [Workers Builds deploy hooks](https://developers.cloudflare.com/workers/ci-cd/builds/deploy-hooks/).

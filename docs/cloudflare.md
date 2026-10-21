# Deploy Strevy to Cloudflare Workers and R2

The API runs at `https://api.tristancheng.com`. Its private R2 bucket stores the
Strava and Hevy output in separate prefixes. The Worker reads Strava objects and serves the existing
`/api/runs` and `/api/runs/media/...` endpoints. There is no database to create.

This setup uses Cloudflare's [Express integration](https://developers.cloudflare.com/workers/tutorials/deploy-an-express-app/)
and [R2 Worker bindings](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
The Puppeteer scraper continues running on your computer. It is not bundled into
the Worker or scheduled by this configuration.

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
npm run upload:r2 -- --local --source strava
npm run dev:worker
```

Open `http://localhost:8787/health` and `http://localhost:8787/api/runs`.
The image URLs returned by the second endpoint work on the same host. Local R2
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
if desired. Uploading Hevy stores its output but does not add a Hevy API endpoint.

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

The health check confirms the API is responding. Before a snapshot is uploaded,
the runs endpoint returns HTTP 503. Missing image objects return JSON 404.

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
is off. Scheduled scraping is a separate future step.

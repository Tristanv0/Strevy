# Deploy Strevy to Cloudflare Workers and R2

The API runs at `https://api.tristancheng.com`. Its private R2 bucket stores the
JSON snapshot and PNGs. The Worker reads those objects and serves the existing
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
npm run upload:r2 -- --local
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

## 4. Upload the existing snapshot and images

Preview the objects first if desired:

```sh
npm run upload:r2 -- --remote --dry-run
```

Then upload them:

```sh
npm run upload:r2 -- --remote
```

The script validates the snapshot's local PNG paths and captures their contents
before uploading. It uploads only referenced local images, preserves external
photo URLs, and publishes `latest-runs.json` last. If a media upload fails, the
new JSON is not published. Earlier image uploads are not rolled back.

The bucket layout matches the local output layout:

```text
latest-runs.json
media/<activity-id>/route.png
media/<activity-id>/map.png
```

Use `--remote` explicitly for cloud uploads. Without it, the upload command uses
the local emulator. It does not delete older objects.

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

Use `mapImage.url` for the image with street names and a map background.
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
npm run upload:r2 -- --remote
```

The deployed API reads R2 on every request, so it does not need redeployment when
the data changes. Your existing uploaded data stays available when your computer
is off. Scheduled scraping is a separate future step.

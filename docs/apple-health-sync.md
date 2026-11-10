# Shuttls iPhone sync

Health Data Export sends a JSON `workouts` array. The receiver recognizes the
observed Shuttls bundle identifier (`shut.tleAPP`) and the exporter's `other` or
`badminton` workout label. The November 10 sample labels the matched Shuttls
badminton workouts `other`. The API skips Hevy and other sources. It reads
duration in seconds, energy in kcal, distance in metres or kilometres, and
average heart rate in BPM. Routes, device metadata, and raw heart rate samples
are never saved. The authenticated JSON request limit is 8 MB.

1. Generate a random token with `openssl rand -hex 32`. Save it as
   `APPLE_HEALTH_SYNC_TOKEN` in the gitignored `.env` for the historical import
   command. Deploy the updated Worker, then run
   `npx wrangler secret put APPLE_HEALTH_SYNC_TOKEN` and paste the same token at
   Wrangler's prompt. Sync writes are disabled without this secret.
2. Initialize the history **before enabling uploads from your phone**:

   ```sh
   npm run seed:badminton -- --url https://api.tristancheng.com
   ```

   This reads the local `imports/apple-health/output/badminton-workouts.json`,
   sends only recent normalized Shuttls match summaries and older lifetime totals,
   and creates the sync state once. Repeat imports return HTTP 409 to protect
   existing synced data. Keep the original history locally.
3. In **Health Data Export → Automation → +**, choose **HTTPS webhook**, enter
   `https://api.tristancheng.com/api/apple-health/sync`, and enter the same token in
   the bearer token field. Select **Workouts**, JSON, a recent date range (such as
   the past seven days), and a daily schedule. Disable routes and individual heart
   rate samples if the app offers those switches. Use **Run Now** to verify a real
   delivery before relying on the schedule. iOS background timing can vary.

Successful syncs return counts for `added`, `duplicates`, `outsideWindow`, and
`ignored`. A replay updates no totals. The receiver matches the exporter workout
ID or the start and end timestamps; that also reconciles overlapping XML history.
If a match is already known, the original metric values are preserved.

R2 stores one private `badminton/sync-state.json` object with the recent match
summaries and older lifetime totals. Conditional writes prevent overlapping
requests from dropping matches. The API returns only daily summaries and lifetime
totals at the public `GET /api/badminton` route. Each night, expired match details
roll into lifetime totals and are removed; later exports outside the six-month
window are ignored. `badminton/daily.json` remains the manual fallback before
initialization. If the frontend fetches data only at build time, it will show the
new summary after its next build.

To try the same flow locally, set the token in `.dev.vars`, start
`npm run dev:worker`, and run `npm run seed:badminton` from another terminal.
Use a local HTTP client to POST a saved export to the local `/api/apple-health/sync`
route with `Authorization: Bearer <token>` and `Content-Type: application/json`.
The default seed URL is `http://localhost:8787`; local tests use local R2.

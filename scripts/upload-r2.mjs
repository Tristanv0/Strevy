import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isMediaKey } from '../src/lib/media.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultOutput = join(root, 'scrapers/strava/output');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export async function buildUploadPlan(outputDirectory = defaultOutput) {
  const directory = await realpath(outputDirectory);
  const body = await readFile(join(directory, 'latest-runs.json'));
  const snapshot = JSON.parse(body.toString('utf8'));
  if (!Array.isArray(snapshot.runs)) throw new Error('The snapshot must contain a runs array.');
  const keys = new Set();
  for (const run of snapshot.runs) {
    for (const image of [run.routeImage, run.mapImage, ...(run.photos ?? [])]) {
      // Remote uploaded-photo URLs stay in the JSON; they are not downloaded.
      if (!image?.path) continue;
      if (!isMediaKey(image.path)) throw new Error('The snapshot contains an unsupported media path.');
      keys.add(image.path);
    }
  }
  const plan = [];
  for (const key of keys) {
    const path = await realpath(join(directory, key));
    if (!path.startsWith(directory + sep)) throw new Error('Media must be inside the output directory.');
    const bytes = await readFile(path);
    if (!bytes.subarray(0, 8).equals(pngSignature)) throw new Error(`Expected PNG data for ${key}.`);
    plan.push({ key, body: bytes, contentType: 'image/png' });
  }
  // Publish the snapshot only after all of its referenced files have uploaded.
  plan.push({ key: 'latest-runs.json', body, contentType: 'application/json' });
  return plan;
}

async function runWrangler(args) {
  const cli = join(root, 'node_modules/wrangler/bin/wrangler.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' },
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('R2 upload failed; the new snapshot was not published.')));
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    remote: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    bucket: { type: 'string', default: 'strevy-data' },
    directory: { type: 'string', default: defaultOutput },
  } });
  if (values.remote && values.local) throw new Error('Choose either --local or --remote.');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.bucket)) throw new Error('Invalid R2 bucket name.');
  const plan = await buildUploadPlan(values.directory);
  console.log(`${values['dry-run'] ? 'Preview' : 'Uploading'}: ${plan.length - 1} images and one snapshot to ${values.remote ? 'remote' : 'local'} R2 (${values.bucket}).`);
  if (values['dry-run']) {
    for (const item of plan) console.log(item.key);
    return;
  }
  const staging = await mkdtemp(join(tmpdir(), 'strevy-r2-upload-'));
  try {
    for (const [index, item] of plan.entries()) {
      // Stage captured bytes so a simultaneous scrape cannot change this upload.
      const file = join(staging, String(index));
      await writeFile(file, item.body, { mode: 0o600 });
      await runWrangler(['r2', 'object', 'put', `${values.bucket}/${item.key}`,
        '--file', file, '--content-type', item.contentType,
        '--config', join(root, 'wrangler.jsonc'),
        ...(values.remote ? ['--remote'] : ['--local', '--persist-to', join(root, '.wrangler/state')]),
      ]);
    }
    console.log('Upload complete. The API can now read the updated snapshot.');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

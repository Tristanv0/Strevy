import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parse as parseJsonc } from 'jsonc-parser';
import { isMediaKey } from '../src/lib/media.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const defaultOutput = join(root, 'scrapers/strava/output');
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const sources = {
  strava: { snapshot: 'latest-runs.json', collection: 'runs' },
  hevy: { snapshot: 'latest-workouts.json', collection: 'workouts' },
};

export async function buildUploadPlan(outputDirectory = defaultOutput, source = 'strava') {
  const settings = sources[source];
  if (!settings) throw new Error('Choose --source strava, hevy, or all.');
  const directory = await realpath(outputDirectory);
  const snapshotPath = join(directory, settings.snapshot);
  if (!(await realpath(snapshotPath)).startsWith(directory + sep)) {
    throw new Error('The snapshot must be inside the output directory.');
  }
  const body = await readFile(snapshotPath);
  const snapshot = JSON.parse(body.toString('utf8'));
  if (!Array.isArray(snapshot[settings.collection])) {
    throw new Error(`The ${source} snapshot must contain a ${settings.collection} array.`);
  }
  const keys = new Set();
  for (const run of source === 'strava' ? snapshot.runs : []) {
    for (const image of [run.routeImage, run.mapImage, ...(run.photos ?? [])]) {
      // Remote photo and static-map URLs stay in JSON; they are not downloaded.
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
  plan.push({ key: settings.snapshot, body, contentType: 'application/json' });
  return plan;
}

export async function buildDirectoryUploadPlan(outputDirectory = defaultOutput, source = 'strava') {
  if (!sources[source]) throw new Error('Choose --source strava, hevy, or all.');
  const directory = await realpath(outputDirectory);
  const paths = [];
  async function walk(relative = '') {
    const entries = await readdir(join(directory, relative), { withFileTypes: true });
    for (const entry of entries) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symlinks are not supported in output: ${key}.`);
      if (entry.isDirectory()) await walk(key);
      else if (entry.isFile()) {
        if (key.endsWith('.tmp')) throw new Error('Output contains temporary files. Wait for the scraper to finish.');
        paths.push(key);
      } else throw new Error(`Unsupported output entry: ${key}.`);
    }
  }
  await walk();
  // Validate the snapshot and all referenced images before clearing this source.
  const validated = await buildUploadPlan(directory, source);
  const captured = new Map(validated.map(item => [item.key, item]));
  const types = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
  const plan = [];
  // A scrape may publish a new snapshot after the walk. Include every captured
  // reference even if its file appeared after that directory listing.
  for (const key of [...new Set([...paths, ...captured.keys()])].sort()) {
    if (key === sources[source].snapshot) continue;
    plan.push(captured.get(key) ?? {
      key, body: await readFile(join(directory, key)),
      contentType: types[extname(key).toLowerCase()] ?? 'application/octet-stream',
    });
  }
  plan.push(captured.get(sources[source].snapshot));
  return plan;
}

export async function buildSourceUploadPlan({ source = 'strava', directory } = {}) {
  if (!['strava', 'hevy', 'all'].includes(source)) throw new Error('Choose --source strava, hevy, or all.');
  if (source === 'all' && directory) throw new Error('--directory requires a single --source (strava or hevy).');
  const selected = source === 'all' ? ['strava', 'hevy'] : [source];
  const plan = [];
  for (const name of selected) {
    const items = await buildDirectoryUploadPlan(directory ?? join(root, 'scrapers', name, 'output'), name);
    plan.push(...items.map(item => ({ ...item, key: `${name}/${item.key}` })));
  }
  // Upload all media before publishing either source's snapshot.
  const snapshotKeys = new Set(selected.map(name => `${name}/${sources[name].snapshot}`));
  return { selected, plan: [
    ...plan.filter(item => !snapshotKeys.has(item.key)),
    ...plan.filter(item => snapshotKeys.has(item.key)),
  ] };
}

export async function emptyBucket(bucket, prefix) {
  if (!['strava/', 'hevy/'].includes(prefix)) throw new Error('Deletion requires a strava/ or hevy/ prefix.');
  // Collect every page before deleting: deleting during pagination can skip keys.
  const keys = new Set();
  let cursor;
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    for (const object of page.objects) {
      if (!object.key.startsWith(prefix)) throw new Error('R2 returned an object outside the selected source; no objects were deleted.');
      keys.add(object.key);
    }
    const next = page.truncated ? page.cursor : undefined;
    if (page.truncated && (!next || next === cursor)) throw new Error('R2 listing did not advance; no objects were deleted.');
    cursor = next;
  } while (cursor);
  const listed = [...keys];
  for (let index = 0; index < listed.length; index += 1000) {
    await bucket.delete(listed.slice(index, index + 1000));
  }
  return listed.length;
}

async function clearBucket(bucketName, remote, staging, selected) {
  const errors = [];
  const config = parseJsonc(await readFile(join(root, 'wrangler.jsonc'), 'utf8'), errors,
    { allowTrailingComma: true });
  if (errors.length) throw new Error('Could not parse wrangler.jsonc; the bucket was not cleared.');
  const configPath = join(staging, 'wrangler.jsonc');
  // Use a separate binding so --local cannot accidentally access a remote binding.
  await writeFile(configPath, JSON.stringify({
    name: 'strevy-r2-upload', account_id: config.account_id,
    compatibility_date: config.compatibility_date,
    r2_buckets: [{ binding: 'UPLOAD_BUCKET', bucket_name: bucketName, remote }],
  }));
  const { getPlatformProxy } = await import('wrangler');
  const platform = await getPlatformProxy({
    configPath, envFiles: [], remoteBindings: remote,
    persist: { path: join(root, '.wrangler/state/v3') },
  });
  try {
    for (const source of selected) {
      const count = await emptyBucket(platform.env.UPLOAD_BUCKET, `${source}/`);
      console.log(`Cleared ${count} objects from ${remote ? 'remote' : 'local'} R2 ${bucketName}/${source}/.`);
    }
  } finally {
    await platform.dispose();
  }
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
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('R2 upload failed. Selected source folders may be only partially refilled; rerun the upload.')));
  });
}

async function main() {
  const { values } = parseArgs({ options: {
    remote: { type: 'boolean', default: false },
    local: { type: 'boolean', default: false },
    replace: { type: 'boolean', default: false },
    source: { type: 'string', default: 'strava' },
    'dry-run': { type: 'boolean', default: false },
    bucket: { type: 'string', default: 'strevy-data' },
    directory: { type: 'string' },
  } });
  if (values.remote && values.local) throw new Error('Choose either --local or --remote.');
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(values.bucket)) throw new Error('Invalid R2 bucket name.');
  const { selected, plan } = await buildSourceUploadPlan({ source: values.source, directory: values.directory });
  console.log(`${values['dry-run'] ? 'Preview' : 'Uploading'}: ${plan.length} files to ${values.remote ? 'remote' : 'local'} R2 (${values.bucket}).`);
  console.log(`REPLACE: only ${selected.map(source => `${source}/`).join(' and ')} will be cleared and replaced with the selected local output. Other objects are retained.`);
  if (values['dry-run']) {
    for (const item of plan) console.log(item.key);
    return;
  }
  const staging = await mkdtemp(join(tmpdir(), 'strevy-r2-upload-'));
  try {
    // Finish staging all bytes on disk before any destructive operation.
    for (const [index, item] of plan.entries()) {
      await writeFile(join(staging, String(index)), item.body, { mode: 0o600 });
    }
    await clearBucket(values.bucket, values.remote, staging, selected);
    for (const [index, item] of plan.entries()) {
      const file = join(staging, String(index));
      await runWrangler(['r2', 'object', 'put', `${values.bucket}/${item.key}`,
        '--file', file, '--content-type', item.contentType,
        '--config', join(root, 'wrangler.jsonc'),
        ...(values.remote ? ['--remote'] : ['--local', '--persist-to', join(root, '.wrangler/state')]),
      ]);
    }
    console.log('Upload complete. Selected source snapshots and files have been replaced.');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { buildBadmintonSyncSeed } from '../src/lib/badminton-sync.js';

const root = new URL('../', import.meta.url);

try {
  const { values } = parseArgs({ options: {
    url: { type: 'string', default: 'http://localhost:8787' },
    input: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  } });
  const history = values.input ?? new URL('imports/apple-health/output/badminton-workouts.json', root);
  const seed = buildBadmintonSyncSeed(JSON.parse(await readFile(history, 'utf8')));
  const origin = new URL(values.url);
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new Error('Use an HTTPS API origin or a localhost URL, without a path or credentials.');
  }
  console.log(`${values['dry-run'] ? 'Preview' : 'Importing'}: ${seed.matches.length} recent Shuttls matches plus older lifetime totals to ${origin.origin}.`);
  if (!values['dry-run']) {
    const envFile = new URL(origin.protocol === 'http:' ? '.dev.vars' : '.env', root);
    let local = {};
    try { local = parseEnv(await readFile(envFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const token = process.env.APPLE_HEALTH_SYNC_TOKEN ?? local.APPLE_HEALTH_SYNC_TOKEN;
    if (!token || token.length < 32) throw new Error('Set APPLE_HEALTH_SYNC_TOKEN to the Worker’s sync secret.');
    const response = await fetch(new URL('/api/apple-health/bootstrap', origin), {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(seed),
    });
    if (!response.ok) throw new Error(`Import failed (HTTP ${response.status}). A 409 means sync has already been initialized.`);
    console.log('Badminton sync initialized. Historical matches are ready for deduplication.');
  }
} catch (error) {
  console.error(`Could not initialize badminton sync: ${error.code ?? error.message}`);
  process.exitCode = 1;
}

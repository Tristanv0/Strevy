import { readFile } from 'node:fs/promises';
import { parseArgs, parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { frontendDeployHook } from '../src/automation/hevy-refresh.js';

const { values } = parseArgs({ options: { 'dry-run': { type: 'boolean', default: false } } });
const root = new URL('../', import.meta.url);
let local = {};
try { local = parseEnv(await readFile(new URL('.env', root), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const secrets = Object.fromEntries(['HEVY_EMAIL', 'HEVY_PASSWORD', 'FRONTEND_DEPLOY_HOOK_URL']
  .map(key => [key, process.env[key] || local[key]]));
for (const [key, value] of Object.entries(secrets)) {
  if (!value) throw new Error(`${key} is missing. Set it in the root .env file or environment.`);
}
frontendDeployHook(secrets.FRONTEND_DEPLOY_HOOK_URL);
if (values['dry-run']) {
  console.log(`Ready to configure Worker secrets: ${Object.keys(secrets).join(', ')}. Values are hidden.`);
} else {
  const child = spawn(process.execPath, [fileURLToPath(new URL('node_modules/wrangler/bin/wrangler.js', root)),
    'secret', 'bulk', '--config', fileURLToPath(new URL('wrangler.jsonc', root))], {
    cwd: fileURLToPath(root), stdio: ['pipe', 'inherit', 'inherit'],
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(secrets));
  child.on('error', () => { console.error('Could not start Wrangler to configure Hevy secrets.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code === 0 ? 0 : 1; });
}

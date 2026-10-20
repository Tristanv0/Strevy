import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import createApp from './app.js';
import { createLocalRunsStore } from './storage/local.js';

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const port = Number(process.env.PORT ?? 3001);
const host = process.env.HOST ?? '127.0.0.1';
const app = createApp({
  runsStore: createLocalRunsStore(),
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? 'http://localhost:3000,http://localhost:5173',
});

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535.');
}

const server = app.listen(port, host, () => {
  console.log(`Strevy API listening at http://${host}:${port}`);
});

server.on('error', error => {
  console.error(`Could not start Strevy API: ${error.code || 'unknown error'}.`);
  process.exitCode = 1;
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => server.close());
}

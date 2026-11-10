import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { BADMINTON_FILENAME, summarizeBadmintonWorkouts } from '../src/lib/badminton.js';

const directory = new URL('../imports/apple-health/output/', import.meta.url);
const output = new URL(BADMINTON_FILENAME, directory);
const { values } = parseArgs({ options: { input: { type: 'string' } } });
const input = values.input ?? new URL('badminton-workouts.json', directory);

try {
  const snapshot = summarizeBadmintonWorkouts(JSON.parse(await readFile(input, 'utf8')));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = new URL(`${BADMINTON_FILENAME}.${randomUUID()}.tmp`, directory);
  try {
    await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  const matches = snapshot.days.reduce((sum, day) => sum + day.rallyCount, 0);
  console.log(`Saved ${snapshot.count} Toronto dates from ${matches} Shuttls workouts to ${fileURLToPath(output)}.`);
} catch (error) {
  console.error(`Could not summarize badminton workouts: ${error.code ?? error.message}`);
  process.exitCode = 1;
}

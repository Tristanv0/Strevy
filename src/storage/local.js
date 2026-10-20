import { readFile } from 'node:fs/promises';
import { isMediaKey } from '../lib/media.js';

const defaultDirectory = new URL('../../scrapers/strava/output/', import.meta.url);

export function createLocalRunsStore(outputDirectory = defaultDirectory) {
  async function read(key) {
    try {
      return await readFile(new URL(key, outputDirectory));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }
  return {
    async readSnapshot() {
      const data = await read('latest-runs.json');
      return data === null ? null : JSON.parse(data.toString('utf8'));
    },
    async readMedia(key) {
      if (!isMediaKey(key)) return null;
      const body = await read(key);
      return body === null ? null : { body, contentType: 'image/png' };
    },
  };
}

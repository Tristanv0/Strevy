import { Buffer } from 'node:buffer';
import { isMediaKey } from '../lib/media.js';

export function createR2RunsStore(bucket) {
  if (!bucket) throw new Error('The STREVY_DATA R2 binding is missing.');
  return {
    async readSnapshot() {
      const object = await bucket.get('strava/latest-runs.json');
      return object ? object.json() : null;
    },
    async readMedia(key) {
      if (!isMediaKey(key)) return null;
      const object = await bucket.get(`strava/${key}`);
      if (!object) return null;
      return { body: Buffer.from(await object.arrayBuffer()), contentType: 'image/png', etag: object.httpEtag };
    },
  };
}

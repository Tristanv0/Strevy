import { Buffer } from 'node:buffer';
import { isMediaKey } from '../lib/media.js';
import { BADMINTON_R2_KEY, retainBadmintonDays } from '../lib/badminton.js';
import {
  BADMINTON_SYNC_KEY, BadmintonSyncError, mergePhoneWorkouts, pruneBadmintonSyncState,
  reportBadmintonSync, validateBadmintonSyncState,
} from '../lib/badminton-sync.js';

export function createR2BadmintonStore(bucket) {
  if (!bucket) throw new Error('The STREVY_DATA R2 binding is missing.');
  const writeState = (state, onlyIf) => bucket.put(BADMINTON_SYNC_KEY, JSON.stringify(state), {
    onlyIf, httpMetadata: { contentType: 'application/json' },
  });
  async function updateState(transform, required = true) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const object = await bucket.get(BADMINTON_SYNC_KEY);
      if (!object) {
        if (required) throw new BadmintonSyncError('Import the historical badminton seed before syncing.', 409);
        return 0;
      }
      const state = await object.json();
      const next = transform(state);
      if (next.state === state || await writeState(next.state, { etagMatches: object.etag })) return next.result;
    }
    throw new BadmintonSyncError('The badminton sync state is busy; retry shortly.', 503);
  }
  return {
    async readSnapshot() {
      const sync = await bucket.get(BADMINTON_SYNC_KEY);
      if (sync) return reportBadmintonSync(await sync.json());
      const object = await bucket.get(BADMINTON_R2_KEY);
      return object ? object.json() : null;
    },
    async bootstrapSync(seed, now = new Date()) {
      const state = pruneBadmintonSyncState(validateBadmintonSyncState(seed), now);
      if (!await writeState(state, { etagDoesNotMatch: '*' })) {
        throw new BadmintonSyncError('Badminton sync has already been initialized.', 409);
      }
      return { retainedMatches: state.matches.length };
    },
    async mergeSync(batch, now = new Date()) {
      return updateState(state => mergePhoneWorkouts(state, batch, now));
    },
    async pruneExpiredSync(now = new Date()) {
      return updateState(state => {
        const retained = pruneBadmintonSyncState(state, now);
        return { state: retained, result: state.matches.length - retained.matches.length };
      }, false);
    },
    async pruneExpired(now = new Date()) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const object = await bucket.get(BADMINTON_R2_KEY);
        if (!object) return 0;
        const snapshot = await object.json();
        const retained = retainBadmintonDays(snapshot, now);
        const removed = snapshot.days.length - retained.count;
        if (!removed) return 0;
        // Re-read on a race so cleanup cannot overwrite a concurrent upload.
        const updated = await bucket.put(BADMINTON_R2_KEY, `${JSON.stringify(retained, null, 2)}\n`, {
          onlyIf: { etagMatches: object.etag },
          httpMetadata: { contentType: 'application/json' },
        });
        if (updated) return removed;
      }
      throw new Error('The badminton snapshot changed while pruning expired days.');
    },
  };
}

export function createR2WorkoutsStore(bucket) {
  if (!bucket) throw new Error('The STREVY_DATA R2 binding is missing.');
  return {
    async readSnapshot() {
      const object = await bucket.get('hevy/latest-workouts.json');
      return object ? object.json() : null;
    },
  };
}

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

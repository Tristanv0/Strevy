import { badmintonDate, badmintonRetentionWindow, summarizeBadmintonWorkouts } from './badminton.js';

export const BADMINTON_SYNC_KEY = 'badminton/sync-state.json';

export class BadmintonSyncError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function number(value, field, nullable = false) {
  if (nullable && value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new BadmintonSyncError(`Invalid ${field}.`);
  }
  return value;
}

function instant(value) {
  const time = typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
  if (!Number.isFinite(time)) throw new BadmintonSyncError('Expected a workout timestamp with a timezone offset.');
  // Apple Health's XML and the observed exporter both identify matches to the second.
  return new Date(Math.floor(time / 1000) * 1000).toISOString();
}

function normalizeMatch(row) {
  const startTime = instant(row?.startTime);
  const endTime = instant(row?.endTime);
  if (endTime < startTime) throw new BadmintonSyncError('Workout end precedes start.');
  const average = number(row.heartRateBpm?.average, 'average heart rate', true);
  if (row.exportId != null && (typeof row.exportId !== 'string' || !/^[a-z0-9-]{1,128}$/i.test(row.exportId))) {
    throw new BadmintonSyncError('Invalid workout identifier.');
  }
  return {
    source: 'Shuttls', startTime, endTime,
    durationSeconds: number(row.durationSeconds, 'duration'),
    activeEnergyKcal: number(row.activeEnergyKcal, 'active calories', true),
    walkingRunningDistanceKm: number(row.walkingRunningDistanceKm, 'distance', true),
    heartRateBpm: average === null ? null : { average },
    ...(row.exportId == null ? {} : { exportId: row.exportId.toLowerCase() }),
  };
}

const matchKey = row => `${row.startTime}/${row.endTime}`;
const dateOf = row => badmintonDate(Date.parse(row.startTime));
const add = (a, b) => b === null ? a : (a ?? 0) + b;

export function parsePhoneWorkouts(payload) {
  if (!Array.isArray(payload?.workouts)) {
    throw new BadmintonSyncError('Expected a Health Data Export JSON object with a workouts array.');
  }
  const matches = [];
  for (const row of payload.workouts) {
    // This export maps verified Shuttls badminton matches to type "other".
    if (row?.source?.bundle_identifier !== 'shut.tleAPP' || !['other', 'badminton'].includes(row.type)) continue;
    if (row.energy != null && row.energy_unit !== 'kcal') throw new BadmintonSyncError('Expected workout energy in kcal.');
    if (row.distance != null && !['m', 'km'].includes(row.distance_unit)) throw new BadmintonSyncError('Expected workout distance in m or km.');
    if (row.heart_rate?.average != null && row.heart_rate.unit !== 'bpm') throw new BadmintonSyncError('Expected workout heart rate in bpm.');
    const distance = number(row.distance, 'distance', true);
    matches.push(normalizeMatch({
      startTime: row.start_date, endTime: row.end_date, exportId: row.id,
      durationSeconds: row.duration, activeEnergyKcal: row.energy,
      walkingRunningDistanceKm: distance === null || row.distance_unit === 'km' ? distance : distance / 1000,
      heartRateBpm: { average: row.heart_rate?.average },
    }));
  }
  return { matches, ignored: payload.workouts.length - matches.length };
}

export function validateBadmintonSyncState(state) {
  if (state?.schemaVersion !== 1 || !state.archived || !Array.isArray(state.matches)) {
    throw new BadmintonSyncError('Expected a badminton sync seed.');
  }
  const matches = state.matches.map(row => {
    if (row?.source !== 'Shuttls') throw new BadmintonSyncError('A sync seed can only contain Shuttls workouts.');
    return normalizeMatch(row);
  });
  const ids = matches.flatMap(row => row.exportId ? [row.exportId] : []);
  if (new Set(matches.map(matchKey)).size !== matches.length || new Set(ids).size !== ids.length) {
    throw new BadmintonSyncError('Duplicate workout identities in the sync seed.');
  }
  return { schemaVersion: 1, archived: {
    durationSeconds: number(state.archived.durationSeconds, 'archived duration'),
    activeEnergyKcal: number(state.archived.activeEnergyKcal, 'archived calories', true),
  }, matches };
}

export function pruneBadmintonSyncState(state, now = new Date()) {
  const { from } = badmintonRetentionWindow(now);
  const matches = [];
  const archived = { ...state.archived };
  for (const row of state.matches) {
    if (dateOf(row) >= from) matches.push(row);
    else {
      archived.durationSeconds += row.durationSeconds;
      archived.activeEnergyKcal = add(archived.activeEnergyKcal, row.activeEnergyKcal);
    }
  }
  return matches.length === state.matches.length ? state : { ...state, archived, matches };
}

export function buildBadmintonSyncSeed(history, now = new Date()) {
  if (history?.schemaVersion !== 1 || history.activityType !== 'badminton' || !Array.isArray(history.workouts)) {
    throw new BadmintonSyncError('Expected an Apple Health badminton workout export.');
  }
  const through = badmintonDate(now);
  const matches = history.workouts.filter(row => row?.source === 'Shuttls').map(normalizeMatch)
    .filter(row => dateOf(row) <= through);
  return pruneBadmintonSyncState(validateBadmintonSyncState({ schemaVersion: 1,
    archived: { durationSeconds: 0, activeEnergyKcal: null }, matches,
  }), now);
}

export function mergePhoneWorkouts(state, batch, now = new Date()) {
  const retained = pruneBadmintonSyncState(state, now);
  const { from, through } = badmintonRetentionWindow(now);
  const matches = [...retained.matches];
  const times = new Map(matches.map((row, index) => [matchKey(row), index]));
  const ids = new Set(matches.flatMap(row => row.exportId ? [row.exportId] : []));
  const result = { added: 0, duplicates: 0, outsideWindow: 0, ignored: batch.ignored };
  let changed = false;
  for (const row of batch.matches) {
    const date = dateOf(row);
    // Once a match has aged into lifetime totals, old resends cannot count again.
    if (date < from || date > through) { result.outsideWindow++; continue; }
    if (row.exportId && ids.has(row.exportId)) { result.duplicates++; continue; }
    const key = matchKey(row);
    const index = times.get(key);
    if (index !== undefined) {
      // Keep the historical values for overlap; learn the exporter's ID if available.
      if (row.exportId && !matches[index].exportId) {
        matches[index] = { ...matches[index], exportId: row.exportId };
        ids.add(row.exportId);
        changed = true;
      }
      result.duplicates++;
      continue;
    }
    times.set(key, matches.length);
    if (row.exportId) ids.add(row.exportId);
    matches.push(row);
    result.added++;
    changed = true;
  }
  return { state: changed ? { ...retained, matches } : retained, result };
}

export function reportBadmintonSync(state, now = new Date()) {
  return summarizeBadmintonWorkouts({ schemaVersion: 1, activityType: 'badminton', workouts: state.matches }, now, state.archived);
}

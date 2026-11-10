export const BADMINTON_FILENAME = 'badminton-daily.json';
export const BADMINTON_R2_KEY = 'badminton/daily.json';
export const BADMINTON_TIME_ZONE = 'America/Toronto';
const retentionMonths = 6;
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: BADMINTON_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});

export function badmintonDate(time) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(time).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function badmintonRetentionWindow(now) {
  const through = badmintonDate(now);
  const [year, month, day] = through.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 - retentionMonths, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return { from: target.toISOString().slice(0, 10), through };
}

function metric(value, field, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid badminton ${field}.`);
  }
  return value;
}

function report(days, { lifetimeActiveEnergyKcal, lifetimeDurationSeconds }) {
  return {
    schemaVersion: 1,
    activityType: 'badminton',
    source: 'Shuttls',
    timeZone: BADMINTON_TIME_ZONE,
    retentionMonths,
    lifetimeActiveEnergyKcal,
    lifetimeDurationSeconds,
    count: days.length,
    days,
  };
}

export function retainBadmintonDays(snapshot, now = new Date()) {
  if (snapshot?.schemaVersion !== 1 || snapshot.activityType !== 'badminton'
    || snapshot.source !== 'Shuttls' || snapshot.timeZone !== BADMINTON_TIME_ZONE
    || !Array.isArray(snapshot.days)) {
    throw new Error('Expected a Shuttls daily badminton snapshot.');
  }
  const { from, through } = badmintonRetentionWindow(now);
  // Recent days cannot reconstruct lifetime totals missing from older snapshots.
  const lifetime = {
    lifetimeActiveEnergyKcal: metric(snapshot.lifetimeActiveEnergyKcal ?? null, 'lifetime active calories', true),
    lifetimeDurationSeconds: metric(snapshot.lifetimeDurationSeconds ?? null, 'lifetime duration', true),
  };
  const seen = new Set();
  const days = [];
  for (const row of snapshot.days) {
    const date = row?.date;
    const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date) : NaN;
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date || seen.has(date)) {
      throw new Error('Expected one valid badminton summary per calendar date.');
    }
    seen.add(date);
    if (!Number.isSafeInteger(row.rallyCount) || row.rallyCount < 1) throw new Error('Invalid badminton rally count.');
    // Allowlist public fields so raw workout records never leak through a snapshot.
    const day = {
      date,
      durationSeconds: metric(row.durationSeconds, 'duration'),
      activeEnergyKcal: metric(row.activeEnergyKcal, 'active calories', true),
      averageHeartRateBpm: metric(row.averageHeartRateBpm, 'heart rate', true),
      walkingRunningDistanceKm: metric(row.walkingRunningDistanceKm, 'distance', true),
      rallyCount: row.rallyCount,
    };
    if (date >= from && date <= through) days.push(day);
  }
  return report(days.sort((a, b) => b.date.localeCompare(a.date)), lifetime);
}

const round = (value, digits) => value === null ? null : Number(value.toFixed(digits));
const add = (total, value) => value === null ? total : (total ?? 0) + value;

export function summarizeBadmintonWorkouts(snapshot, now = new Date(), archived = {}) {
  if (snapshot?.schemaVersion !== 1 || snapshot.activityType !== 'badminton' || !Array.isArray(snapshot.workouts)) {
    throw new Error('Expected an Apple Health badminton workout export.');
  }
  const grouped = new Map();
  const today = badmintonDate(now);
  let lifetimeActiveEnergyKcal = archived.activeEnergyKcal ?? null;
  let lifetimeDurationSeconds = archived.durationSeconds ?? 0;
  for (const workout of snapshot.workouts) {
    if (workout?.source !== 'Shuttls') continue;
    const start = typeof workout.startTime === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(workout.startTime)
      ? Date.parse(workout.startTime) : NaN;
    if (!Number.isFinite(start)) throw new Error('Expected a Shuttls start time with a timezone offset.');
    const date = badmintonDate(start);
    if (date > today) continue;
    const day = grouped.get(date) ?? {
      date, durationSeconds: 0, activeEnergyKcal: null, walkingRunningDistanceKm: null,
      rallyCount: 0, heartRateTotal: 0, heartRateCount: 0,
    };
    const duration = metric(workout.durationSeconds, 'duration');
    day.durationSeconds += duration;
    lifetimeDurationSeconds += duration;
    const calories = metric(workout.activeEnergyKcal ?? null, 'active calories', true);
    day.activeEnergyKcal = add(day.activeEnergyKcal, calories);
    lifetimeActiveEnergyKcal = add(lifetimeActiveEnergyKcal, calories);
    day.walkingRunningDistanceKm = add(day.walkingRunningDistanceKm,
      metric(workout.walkingRunningDistanceKm ?? null, 'distance', true));
    const heartRate = metric(workout.heartRateBpm?.average ?? null, 'heart rate', true);
    if (heartRate !== null) {
      day.heartRateTotal += heartRate;
      day.heartRateCount++;
    }
    day.rallyCount++;
    grouped.set(date, day);
  }
  const days = [...grouped.values()].map(day => ({
    date: day.date,
    durationSeconds: round(day.durationSeconds, 3),
    activeEnergyKcal: round(day.activeEnergyKcal, 2),
    averageHeartRateBpm: day.heartRateCount ? round(day.heartRateTotal / day.heartRateCount, 1) : null,
    walkingRunningDistanceKm: round(day.walkingRunningDistanceKm, 3),
    rallyCount: day.rallyCount,
  }));
  return retainBadmintonDays(report(days, {
    lifetimeActiveEnergyKcal: round(lifetimeActiveEnergyKcal, 2),
    lifetimeDurationSeconds: round(lifetimeDurationSeconds, 3),
  }), now);
}

const finite = value => value === null || value === undefined || value === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const rounded = value => value === null ? null : Math.round(value * 100) / 100;

export function timestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = finite(value);
  const time = numeric === null ? Date.parse(value) : numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  if (!Number.isFinite(time)) throw new Error('Hevy returned an invalid workout timestamp.');
  return time;
}

export function calendarMonthWindow(now = new Date(), timeZone = 'America/Toronto') {
  const end = new Date(now);
  if (!Number.isFinite(end.getTime())) throw new Error('Invalid scrape date.');
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const localDate = time => {
    const parts = Object.fromEntries(formatter.formatToParts(time).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  };
  const firstDay = `${localDate(end).slice(0, 7)}-01`;
  const midnightUtc = Date.parse(`${firstDay}T00:00:00.000Z`);
  // Find the first instant of the local month, including zones with a DST
  // transition at midnight. The calendar boundary need not be midnight UTC.
  let before = midnightUtc - 36 * 60 * 60 * 1000;
  let start = midnightUtc + 36 * 60 * 60 * 1000;
  while (start - before > 1) {
    const middle = Math.floor((before + start) / 2);
    if (localDate(middle) < firstDay) before = middle;
    else start = middle;
  }
  return { start: new Date(start).toISOString(), end: end.toISOString() };
}

export function assertOwnWorkout(workout, account) {
  if (!workout?.id || String(workout.user_id) !== String(account.id)
    || workout.username !== account.username) {
    throw new Error('Hevy returned a workout outside the signed-in account; export stopped.');
  }
  if (timestamp(workout.start_time) === null || typeof workout.name !== 'string') {
    throw new Error('Hevy returned an incomplete workout summary.');
  }
}

function workoutDate(workout, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(timestamp(workout.start_time)));
}

function workoutTime(workout, timeZone) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).format(new Date(timestamp(workout.start_time)));
}

function records(values) {
  const selected = new Map();
  for (const value of values) {
    const type = typeof value === 'string' ? value : value?.type;
    if (typeof type !== 'string') continue;
    const record = { type, value: typeof value === 'string' ? null : finite(value.value) };
    selected.set(JSON.stringify(record), record);
  }
  return [...selected.values()];
}

function array(value) { return Array.isArray(value) ? value : []; }

function weight(kg, unit) {
  return { value: kg === null ? null : rounded(unit === 'lb' ? kg * 2.2046226218487757 : kg), unit };
}

export function fullWorkout(workout, { timeZone = 'America/Toronto', weightUnit = 'kg' } = {}) {
  if (!Array.isArray(workout.exercises)) throw new Error('Hevy did not return workout exercises.');
  const unit = /^lb(s)?$/i.test(weightUnit) ? 'lb' : 'kg';
  const start = timestamp(workout.start_time);
  const end = timestamp(workout.end_time);
  if (end !== null && end < start) throw new Error('Hevy returned a workout ending before it starts.');
  const seconds = end === null ? null : Math.round((end - start) / 1000);
  const minutes = seconds === null ? null : Math.round(seconds / 60);
  const volumeKg = finite(workout.estimated_volume_kg);
  const volume = weight(volumeKg, unit);
  const heartRate = finite(workout.biometrics?.average_heart_rate);
  const exercises = [...workout.exercises].sort((a, b) => (finite(a.priority) ?? 0) - (finite(b.priority) ?? 0))
    .map(exercise => {
      if (!Array.isArray(exercise.sets)) throw new Error('Hevy did not return exercise sets.');
      return {
        id: String(exercise.id), exerciseTemplateId: exercise.exercise_template_id ?? null,
        title: exercise.title, type: exercise.exercise_type ?? null,
        equipment: exercise.equipment_category ?? null, primaryMuscle: exercise.muscle_group ?? null,
        otherMuscles: array(exercise.other_muscles), notes: exercise.notes ?? null,
        supersetId: exercise.superset_id ?? null, restSeconds: finite(exercise.rest_seconds),
        volumeDoublingEnabled: exercise.volume_doubling_enabled === true,
        sets: [...exercise.sets].sort((a, b) => (finite(a.index) ?? 0) - (finite(b.index) ?? 0))
          .map((set, index) => ({
            index: index + 1, type: set.indicator ?? 'normal',
            reps: finite(set.reps), weightKg: finite(set.weight_kg),
            weight: weight(finite(set.weight_kg), unit),
            durationSeconds: finite(set.duration_seconds), distanceMeters: finite(set.distance_meters),
            rpe: finite(set.rpe), customMetric: finite(set.custom_metric),
            personalRecords: records([...array(set.prs), ...array(set.personalRecords)]),
            yearlyRecords: records(array(set.yearly_prs)),
          })),
      };
    });
  const aggregate = field => exercises.flatMap(exercise => exercise.sets.flatMap(set => set[field]
    .map(record => ({ exercise: exercise.title, exerciseId: exercise.id, setIndex: set.index, ...record }))));
  const personalRecords = aggregate('personalRecords');
  const yearlyRecords = aggregate('yearlyRecords');
  return {
    id: String(workout.id), detailLevel: 'full', title: workout.name,
    date: workoutDate(workout, timeZone),
    url: `https://hevy.com/workout/${encodeURIComponent(workout.short_id || workout.id)}`,
    startTime: new Date(start).toISOString(), endTime: end === null ? null : new Date(end).toISOString(),
    duration: { seconds, display: minutes === null ? null : `${Math.floor(minutes / 60)}h ${minutes % 60}m` },
    volumeKg, volume: { ...volume,
      display: volume.value === null ? null : `${Math.round(volume.value).toLocaleString('en-US')} ${unit}`,
      includesWarmupSets: workout.include_warmup_sets ?? null },
    averageHeartRateBpm: heartRate > 0 ? rounded(heartRate) : null,
    calories: finite(workout.biometrics?.total_calories), description: workout.description ?? null,
    exerciseCount: exercises.length, setCount: exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0),
    recordCount: personalRecords.length, records: personalRecords, yearlyRecords, exercises,
  };
}

export function workoutReport(workouts, { account, preferences = {}, now = new Date(), timeZone = 'America/Toronto' }) {
  const period = calendarMonthWindow(now, timeZone);
  const unique = new Map();
  for (const workout of workouts) {
    assertOwnWorkout(workout, account);
    const started = timestamp(workout.start_time);
    if (started <= Date.parse(period.end)) unique.set(workout.id, workout);
  }
  const ordered = [...unique.values()].sort((a, b) => timestamp(b.start_time) - timestamp(a.start_time));
  // The five newest workouts may precede this month; only extra summaries
  // are restricted to the current calendar month.
  const selected = ordered.filter((workout, index) => index < 5 || timestamp(workout.start_time) >= Date.parse(period.start));
  const fullCount = Math.min(5, selected.length);
  return {
    username: account.username, scrapedAt: new Date(now).toISOString(),
    source: 'https://hevy.com/profile', period: { ...period, timeZone },
    count: selected.length, detailedCount: fullCount, summaryCount: selected.length - fullCount,
    workouts: selected.map((workout, index) => index < fullCount
      ? fullWorkout(workout, { timeZone, weightUnit: preferences.weight_unit })
      : { title: workout.name, date: workoutDate(workout, timeZone), time: workoutTime(workout, timeZone) }),
  };
}

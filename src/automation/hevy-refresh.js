export const HEVY_SNAPSHOT_KEY = 'hevy/latest-workouts.json';

export function nightlyHevyRun(scheduledTime) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(scheduledTime)).map(part => [part.type, part.value]));
  if (parts.hour !== '23' || parts.minute !== '59') return null;
  return `hevy-${parts.year}-${parts.month}-${parts.day}`;
}

export function frontendDeployHook(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Set FRONTEND_DEPLOY_HOOK_URL to the frontend Workers Builds deploy hook.'); }
  if (url.origin !== 'https://api.cloudflare.com' || url.username || url.password
    || url.search || url.hash
    || !/^\/client\/v4\/workers\/builds\/deploy_hooks\/[a-zA-Z0-9_-]+$/.test(url.pathname)) {
    throw new Error('FRONTEND_DEPLOY_HOOK_URL must be a Cloudflare Workers Builds deploy hook URL.');
  }
  return url.href;
}

export function validateHevyReport(report) {
  if (!report || !Array.isArray(report.workouts) || report.count !== report.workouts.length
    || !Number.isFinite(Date.parse(report.scrapedAt))) {
    throw new Error('The Hevy scrape did not produce a complete workout report.');
  }
}

export async function publishHevyReport(bucket, report) {
  validateHevyReport(report);
  const current = await bucket.get(HEVY_SNAPSHOT_KEY);
  if (current) {
    const previous = await current.json();
    if (Date.parse(previous.scrapedAt) > Date.parse(report.scrapedAt)) return { published: false };
  }
  const result = await bucket.put(HEVY_SNAPSHOT_KEY, JSON.stringify(report, null, 2) + '\n', {
    httpMetadata: { contentType: 'application/json', cacheControl: 'no-store' },
    // A concurrent upload must not be overwritten between the read and write.
    onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
  });
  if (!result) throw new Error('The Hevy snapshot changed during upload; retrying the publish step.');
  return { published: true };
}

export async function triggerFrontendBuild(hook, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(hook, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
  } catch {
    // Fetch errors can contain the secret hook URL. Never propagate them.
    throw new Error('The frontend deploy hook request failed.');
  }
  try {
    if (!response.ok) throw new Error(`The frontend deploy hook returned HTTP ${response.status}.`);
  } finally {
    await response.body?.cancel();
  }
  return { buildRequested: true };
}

export async function refreshHevy({ env, step, scrape, now, fetchImpl = fetch }) {
  const hook = frontendDeployHook(env.FRONTEND_DEPLOY_HOOK_URL);
  if (!env.HEVY_EMAIL || !env.HEVY_PASSWORD) throw new Error('Set the HEVY_EMAIL and HEVY_PASSWORD Worker secrets.');
  if (!env.STREVY_DATA) throw new Error('The STREVY_DATA R2 binding is missing.');
  const timeZone = env.HEVY_TIMEZONE || 'America/Toronto';
  new Intl.DateTimeFormat('en-CA', { timeZone }).format(now);

  const report = await step.do('scrape-hevy', {
    retries: { limit: 0, delay: '1 second', backoff: 'constant' }, timeout: '5 minutes',
  }, async () => {
    const result = await scrape({ email: env.HEVY_EMAIL, password: env.HEVY_PASSWORD, timeZone, now });
    validateHevyReport(result);
    return result;
  });

  const { published } = await step.do('publish-hevy-to-r2', {
    retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' }, timeout: '1 minute',
  }, () => publishHevyReport(env.STREVY_DATA, report));

  if (!published) return { published: false, buildRequested: false, reason: 'A newer snapshot is already stored.' };
  await step.do('rebuild-frontend', {
    retries: { limit: 3, delay: '30 seconds', backoff: 'exponential' }, timeout: '1 minute',
  }, () => triggerFrontendBuild(hook, fetchImpl));
  return { published: true, buildRequested: true, count: report.count, scrapedAt: report.scrapedAt };
}

export async function scheduleHevyRefresh(controller, env) {
  const id = nightlyHevyRun(controller.scheduledTime);
  if (!id) return;
  try {
    await env.HEVY_REFRESH.create({ id });
    console.log(`Queued Hevy refresh ${id}.`);
  } catch {
    // Cron delivery can repeat. Reuse the date's instance instead of logging in twice.
    try {
      const instance = await env.HEVY_REFRESH.get(id);
      await instance.status();
    } catch {
      throw new Error('Could not queue the nightly Hevy refresh.');
    }
    console.log(`Hevy refresh ${id} already exists.`);
  }
}

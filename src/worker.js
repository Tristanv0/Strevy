import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import createApp from './app.js';
import { createR2BadmintonStore, createR2RunsStore, createR2WorkoutsStore } from './storage/r2.js';
import { nightlyHevyRun, scheduleHevyRefresh } from './automation/hevy-refresh.js';
export { HevyRefreshWorkflow } from './automation/hevy-workflow.js';

const badmintonStore = createR2BadmintonStore(env.STREVY_DATA);
const app = createApp({
  runsStore: createR2RunsStore(env.STREVY_DATA),
  workoutsStore: createR2WorkoutsStore(env.STREVY_DATA),
  badmintonStore,
  appleHealthSyncToken: env.APPLE_HEALTH_SYNC_TOKEN,
  allowedOrigins: env.ALLOWED_ORIGINS,
});

app.listen(3000);
export default {
  ...httpServerHandler({ port: 3000 }),
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduleHevyRefresh(controller, env));
    if (nightlyHevyRun(controller.scheduledTime)) {
      ctx.waitUntil(Promise.all([badmintonStore.pruneExpired(), badmintonStore.pruneExpiredSync()]));
    }
  },
};

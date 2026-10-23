import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import createApp from './app.js';
import { createR2RunsStore, createR2WorkoutsStore } from './storage/r2.js';
import { scheduleHevyRefresh } from './automation/hevy-refresh.js';
export { HevyRefreshWorkflow } from './automation/hevy-workflow.js';

const app = createApp({
  runsStore: createR2RunsStore(env.STREVY_DATA),
  workoutsStore: createR2WorkoutsStore(env.STREVY_DATA),
  allowedOrigins: env.ALLOWED_ORIGINS,
});

app.listen(3000);
export default {
  ...httpServerHandler({ port: 3000 }),
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(scheduleHevyRefresh(controller, env));
  },
};

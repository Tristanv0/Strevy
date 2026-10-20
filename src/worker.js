import { env } from 'cloudflare:workers';
import { httpServerHandler } from 'cloudflare:node';
import createApp from './app.js';
import { createR2RunsStore } from './storage/r2.js';

const app = createApp({
  runsStore: createR2RunsStore(env.STREVY_DATA),
  allowedOrigins: env.ALLOWED_ORIGINS,
});

app.listen(3000);
export default httpServerHandler({ port: 3000 });

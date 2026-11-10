import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import createRunsRouter from './routes/runs.js';
import createWorkoutsRouter from './routes/workouts.js';
import createBadmintonRouter from './routes/badminton.js';
import createAppleHealthRouter from './routes/apple-health.js';

export default function createApp({ runsStore, workoutsStore, badmintonStore, appleHealthSyncToken, allowedOrigins = '' }) {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors({
    origin: allowedOrigins.split(',').map(origin => origin.trim()).filter(Boolean),
    methods: ['GET', 'HEAD', 'OPTIONS'],
  }));
  // Authenticate these requests before reading their larger, workout-only JSON bodies.
  app.use('/api/apple-health', createAppleHealthRouter(badmintonStore, appleHealthSyncToken));
  app.use(express.json());

  app.get('/', (req, res) => {
    res.json({ name: 'Strevy API' });
  });
  app.use('/health', healthRouter);
  app.use('/api/runs', createRunsRouter(runsStore));
  app.use('/api/workouts', createWorkoutsRouter(workoutsStore));
  app.use('/api/badminton', createBadmintonRouter(badmintonStore));

  app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found' });
  });

  // Express also sends parsing errors here, keeping API errors in JSON format.
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Internal server error' : 'Invalid request' });
  });

  return app;
}

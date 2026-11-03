import express from 'express';
import { db } from './shared/db/database';
import { redis } from './shared/queue/redis';

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.get('/api/v1/health', async (_request, response) => {
  const checks: Record<string, 'ok' | 'error'> = { postgres: 'error', redis: 'error' };

  try {
    await db.selectNoFrom((expression) => expression.val(1).as('healthy')).execute();
    checks.postgres = 'ok';
  } catch {
    // Health responses expose status only, never connection details.
  }

  try {
    await redis.ping();
    checks.redis = 'ok';
  } catch {
    // Health responses expose status only, never connection details.
  }

  const healthy = Object.values(checks).every((status) => status === 'ok');
  response.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'error', checks });
});
import { Redis } from 'ioredis';
import { env } from '../config/env';

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export async function closeRedis(): Promise<void> {
  if (redis.status !== 'end') {
    await redis.quit();
  }
}
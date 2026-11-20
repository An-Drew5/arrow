import "dotenv/config";
import { z } from "zod";

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  MIGRATION_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  PII_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
  PLATFORM_ADMIN_EMAIL: z.string().email(),
  PLATFORM_ADMIN_PASSWORD: z.string().min(12).optional(),
});

export const env = environmentSchema.parse(process.env);

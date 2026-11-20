import argon2 from "argon2";
import { Pool } from "pg";
import { env } from "../src/shared/config/env";

async function seedPlatformAdmin(): Promise<void> {
  if (!env.PLATFORM_ADMIN_PASSWORD) {
    throw new Error(
      "Set PLATFORM_ADMIN_PASSWORD in the environment before running this command",
    );
  }

  const passwordHash = await argon2.hash(env.PLATFORM_ADMIN_PASSWORD, {
    type: argon2.argon2id,
  });
  const pool = new Pool({ connectionString: env.MIGRATION_DATABASE_URL });
  try {
    await pool.query(
      `INSERT INTO users (email, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash, status = 'active'`,
      [env.PLATFORM_ADMIN_EMAIL.toLowerCase(), passwordHash],
    );
  } finally {
    await pool.end();
  }
  console.log(
    `Platform administrator configured for ${env.PLATFORM_ADMIN_EMAIL}`,
  );
}

seedPlatformAdmin().catch((error: unknown) => {
  console.error(
    error instanceof Error
      ? error.message
      : "Platform administrator setup failed",
  );
  process.exitCode = 1;
});

process.env.NODE_ENV ??= "test";
process.env.PORT ??= "3000";
process.env.DATABASE_URL ??=
  "postgres://arrow_app:arrow_app_dev@localhost:5432/arrow";
process.env.MIGRATION_DATABASE_URL ??=
  "postgres://arrow_migrator:arrow_migrator_dev@localhost:5432/arrow";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.JWT_ACCESS_SECRET ??= "test-only-access-secret-that-is-long-enough";
process.env.JWT_ACCESS_TTL_SECONDS ??= "900";
process.env.REFRESH_TOKEN_TTL_DAYS ??= "30";
process.env.PLATFORM_ADMIN_EMAIL ??= "platform-admin@example.test";

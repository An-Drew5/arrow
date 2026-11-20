# Arrow School SaaS API

Phase 1 foundation for school tenancy, authentication, role-based authorization, and audit logging. This repository does not include academic, grading, finance, AI, or frontend features.

## Requirements

- Node.js 20 or newer
- Docker Desktop with Compose

Kysely is used for data access because its explicit SQL and transaction boundaries make PostgreSQL row-level security behavior easy to inspect.

## Local setup

```powershell
Copy-Item .env.example .env
npm ci
docker compose up -d --wait
npm run db:migrate
npm run dev
```

The API listens on `http://localhost:3000`. Check `GET /api/v1/health` after the containers start. The local Compose database creates separate `arrow_migrator` and `arrow_app` roles; the API uses `arrow_app`, while migrations and the one-time platform-admin setup use `arrow_migrator`.

Replace the example `JWT_ACCESS_SECRET` with at least 32 random characters before using the service outside local development. Do not use the development database passwords in a deployed environment.

## Platform administrator

Set `PLATFORM_ADMIN_PASSWORD` in the ignored local `.env` file to a strong password of at least 12 characters, then run:

```powershell
npm run platform-admin:seed
```

The configured email in `PLATFORM_ADMIN_EMAIL` is the platform identity. The seed command stores only an Argon2id password hash and does not print the password. Platform credentials authorize only the `/api/v1/platform/...` approval and suspension endpoints.

## API

- `POST /api/v1/schools` registers a pending school and its first `school_admin` membership.
- `POST /api/v1/auth/login` accepts `identifier`, `password`, and optional `schoolSlug`. If a user belongs to multiple schools, the response lists the choices until a slug is supplied.
- `POST /api/v1/auth/refresh` rotates the httpOnly refresh cookie. Reuse of a revoked token revokes its token family.
- `POST /api/v1/auth/logout` revokes the refresh-token family and clears the cookie.
- `GET /api/v1/me` returns the authenticated user, school, roles, and permissions.
- `POST /api/v1/users` creates a school staff membership and requires `users:manage`.
- `GET /api/v1/roles` lists the school roles and their permissions and requires `users:read`.
- `GET /api/v1/classes/:id/assessments` lists open-term assessments visible within the caller's active class/subject assignment.
- `GET /api/v1/audit-log?page=1&limit=50` returns a school-scoped page and requires `audit:read`.
- `POST /api/v1/platform/schools/:id/approve` and `/suspend` require the configured platform administrator and are audited.
- `GET /api/v1/health` checks PostgreSQL and Redis.
- An `all_subjects` teacher assignment requires the assigned membership to have both the `class_teacher` and `subject_teacher` roles.

Authenticated school routes derive the school only from the verified access token. Each request uses one transaction with transaction-local `app.school_id` and `app.user_id` settings. Tenant tables have forced RLS; the app role does not own those tables and does not have `BYPASSRLS`. Audit rows are append-only for the app role.

## Tests and migrations

The integration suite uses real PostgreSQL, not mocks. It creates two schools and checks direct app-role queries and the tenant request middleware across every tenant table. It also checks the PostgreSQL RLS catalog, missing tenant context, permission-denial auditing, and refresh-token reuse.

```powershell
docker compose up -d --wait
npm run db:migrate
npm test
npm run typecheck
```

GitHub Actions starts PostgreSQL 16 and Redis for every push and pull request. The schema-catalog test intentionally requires every application table to be classified and checks that every tenant table has both RLS enabled and forced.

SQL migrations live in `migrations/` and run using `MIGRATION_DATABASE_URL`; the API connects using `DATABASE_URL`.

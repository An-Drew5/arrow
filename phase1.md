# Task: Build Phase 1 (Foundation) of a multi-tenant School Management SaaS

## Context
I'm building a SaaS where each school registers its own isolated workspace. Staff see only what their role allows. Later phases add academics, AI insights and finance. This task is ONLY Phase 1: tenancy, auth, RBAC and audit. Do not build academics, grading, AI, finance or any UI beyond what is listed.

I'm a solo developer who knows Express but not NestJS. Prefer simple, readable code over clever abstractions.

## Stack (do not substitute without asking)
- Node.js 20+, Express, TypeScript (strict mode)
- PostgreSQL 16 with Row-Level Security
- Data access: Drizzle ORM or Kysely (pick one, tell me which and why in one sentence)
- Validation: Zod
- Redis + BullMQ (only set up the connection and a health check for now)
- Auth: short-lived JWT access token + rotating refresh token in an httpOnly cookie; argon2id for password hashes
- Tests: Vitest + Supertest, running against a real Postgres (Docker), not mocks
- Docker Compose for Postgres and Redis; a README with setup steps

## Project layout
Feature modules, one folder each: `auth`, `tenants`, `people`, `audit`, plus `shared` (db, middleware, errors, config). Each module owns its routes, services, queries and tests, and talks to other modules only through exported service functions.

## Multi-tenancy rules (most important part)
1. Shared database, shared schema. Every tenant-owned table has `school_id uuid not null` and an index starting with it.
2. Enable AND FORCE row-level security on every tenant table with a policy like:
   `USING (school_id = current_setting('app.school_id')::uuid) WITH CHECK (same)`
3. The API connects as a non-owner role with NO `BYPASSRLS`. Migrations run under a separate owner role.
4. On every authenticated request, open ONE transaction and run `set_config('app.school_id', <id>, true)` and `set_config('app.user_id', <id>, true)` (transaction-local, so pooled connections cannot leak context). All queries for that request use that transaction.
5. The school id comes ONLY from the verified token. Never from the URL, query string or body.
6. Use composite foreign keys `(school_id, id)` between tenant tables so a row can never reference another school's row.
7. `users` is a global identity table (no school_id). Membership links a user to a school.
8. Platform-admin actions (approving schools) use a separate role/endpoints and are audited.

## Schema for this phase
- `schools`: id, name, slug (unique), region, status (`pending` | `active` | `suspended`), created_at
- `users`: id, email (unique, nullable), phone (unique, nullable; at least one required), password_hash, status, created_at
- `memberships`: id, school_id, user_id, status; unique (school_id, user_id)
- `roles`: id, school_id, name, is_system; unique (school_id, name)
- `role_permissions`: school_id, role_id, permission (string key)
- `membership_roles`: school_id, membership_id, role_id
- `refresh_tokens`: id, user_id, token_hash, expires_at, revoked_at, replaced_by
- `audit_log`: id, school_id, user_id, action, resource_type, resource_id, reason (nullable), metadata jsonb, created_at. Append-only: revoke UPDATE and DELETE from the app role.

Platform permissions are defined in code (a constant list), not free-form. Include these for now: `school:manage`, `users:manage`, `roles:manage`, `audit:read`, plus placeholders for later: `students:read`, `students:write`, `scores:read`, `scores:write`, `attendance:write`, `analytics:read`, `grading:manage`.

Default system roles seeded for each new school: `school_admin`, `headteacher`, `class_teacher`, `subject_teacher`, `records_officer`, `accountant`. Map sensible permissions to each from the list above. Schools may later adjust which permissions a role has, but cannot invent new permissions.

## Endpoints (under /api/v1)
- `POST /schools`: register a school and its first admin (school starts `pending`; first admin gets `school_admin`; seed default roles)
- `POST /auth/login`: email or phone + password. If the user belongs to several schools, require a `schoolSlug` or return the list to choose from. Block login for `pending` or `suspended` schools.
- `POST /auth/refresh`: rotate the refresh token; reuse of a revoked token revokes the whole token family
- `POST /auth/logout`
- `GET /me`: user, current school, roles, permissions
- `POST /users`: school admin creates a staff user in their school with roles (requires `users:manage`)
- `GET /audit-log`: paginated, requires `audit:read`
- `POST /platform/schools/:id/approve` and `/suspend`: platform admin only (separate auth role)
- `GET /health`: checks Postgres and Redis

## Authorization
One central function `can(user, permission, resource?)`. No scattered role-name checks in handlers. Provide an Express middleware `requirePermission('users:manage')` built on it. Leave a clear extension point for scope rules (e.g. "teacher only for assigned classes") that later phases will fill in.

## Audit
Every state-changing request and every denied permission check writes an audit entry (user, school, action, resource, time) inside the same transaction. Failed logins are logged too.

## Other requirements
- Unauthorized access to a resource outside the caller's school or scope returns 404, the same as a non-existent record.
- Consistent error shape: `{ code, message, details? }`.
- Rate-limit login and registration.
- Validate every request body with Zod. Never log passwords, tokens or full request bodies.
- Config from environment variables, validated at startup with Zod; provide `.env.example`.

## Acceptance criteria (the gate for Phase 1)
Write a cross-school isolation test suite that:
1. Creates two schools with users in each.
2. For EVERY tenant table, proves school A cannot SELECT, INSERT, UPDATE or DELETE school B's rows, both through the API and through direct queries as the app role with school A's context set.
3. Proves a query with NO `app.school_id` set returns zero rows, not an error leak.
4. Fails CI automatically if a new tenant table exists without RLS enabled and forced (write a test that inspects `pg_class` / `pg_policies`).
5. Proves a user without `users:manage` cannot create users, and that the denial is audited.
6. Proves refresh-token reuse revokes the token family.

## How to work
- Work in small steps and commit after each, in this order: scaffold and Docker; migrations and RLS; tenant-context middleware; auth; RBAC and `can()`; audit; isolation test suite; README.
- Before writing code, give me a short plan (under 20 lines) and list any assumption you're making. Ask me only about decisions that are hard to reverse.
- Run the tests and show me the results at the end of each step. Do not mark a step done if tests fail.
- Do not add features, libraries or abstractions beyond this spec. If you think something is missing, tell me instead of silently adding it.
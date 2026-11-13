import { createHash, randomUUID } from "node:crypto";
import express from "express";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Pool, type PoolClient } from "pg";
import { sql, type Transaction } from "kysely";
import { app } from "../src/app";
import { createAccessToken } from "../src/auth/token";
import { env } from "../src/shared/config/env";
import { closeDatabase } from "../src/shared/db/database";
import { asyncHandler } from "../src/shared/middleware/async-handler";
import { errorHandler } from "../src/shared/middleware/errors";
import { tenantContext } from "../src/shared/middleware/tenant-context";
import type { Database } from "../src/shared/db/database";

const migrationPool = new Pool({
  connectionString: process.env.MIGRATION_DATABASE_URL,
});
const appPool = new Pool({ connectionString: process.env.DATABASE_URL });
const password = "Test-password-42!";
const fixture = {
  schoolA: randomUUID(),
  schoolB: randomUUID(),
  userA: randomUUID(),
  userB: randomUUID(),
  membershipA: randomUUID(),
  membershipB: randomUUID(),
  roleA: randomUUID(),
  roleB: randomUUID(),
  roleBExtra: randomUUID(),
  auditA: randomUUID(),
  auditB: randomUUID(),
  emailA: `a-${randomUUID()}@example.test`,
  emailB: `b-${randomUUID()}@example.test`,
  slugA: `school-a-${randomUUID()}`,
  slugB: `school-b-${randomUUID()}`,
};

const probeTables = [
  "memberships",
  "roles",
  "role_permissions",
  "membership_roles",
  "audit_log",
] as const;
const tenantTables = [
  ...probeTables,
  "academic_years",
  "terms",
  "classes",
  "subjects",
  "class_subjects",
  "students",
  "guardians",
  "enrollments",
  "teacher_assignments",
  "grading_schemes",
  "grading_scheme_overrides",
  "grade_bands",
  "assessments",
  "scores",
  "score_versions",
  "term_results",
  "attendance",
  "import_jobs",
  "school_settings",
  "student_subject_opt_outs",
  "scheme_components",
  "grading_scales",
  "term_summaries",
  "attendance_registers",
  "school_closures",
  "term_attendance",
  "attendance_versions",
] as const;
type TenantTable = (typeof tenantTables)[number];
type ProbeTable = (typeof probeTables)[number];
type ProbeOperation = "select" | "insert" | "update" | "delete";

interface Probe {
  select(id: string, tx: Transaction<Database>): Promise<number>;
  insert(
    id: string,
    schoolId: string,
    tx: Transaction<Database>,
  ): Promise<number>;
  update(id: string, tx: Transaction<Database>): Promise<number>;
  delete(id: string, tx: Transaction<Database>): Promise<number>;
}

let tokenA: string;
const probes: Record<ProbeTable, Probe> = {
  memberships: {
    select: async (id, tx) =>
      (await sql`SELECT id FROM memberships WHERE id = ${id}::uuid`.execute(tx))
        .rows.length,
    insert: async (id, schoolId, tx) =>
      (
        await sql`
      INSERT INTO memberships (id, school_id, user_id)
      VALUES (${id}::uuid, ${schoolId}::uuid, ${fixture.userB}::uuid) RETURNING id
    `.execute(tx)
      ).rows.length,
    update: async (id, tx) =>
      (
        await sql`
      UPDATE memberships SET status = 'disabled' WHERE id = ${id}::uuid RETURNING id
    `.execute(tx)
      ).rows.length,
    delete: async (id, tx) =>
      (
        await sql`DELETE FROM memberships WHERE id = ${id}::uuid RETURNING id`.execute(
          tx,
        )
      ).rows.length,
  },
  roles: {
    select: async (id, tx) =>
      (await sql`SELECT id FROM roles WHERE id = ${id}::uuid`.execute(tx)).rows
        .length,
    insert: async (id, schoolId, tx) =>
      (
        await sql`
      INSERT INTO roles (id, school_id, name) VALUES (${id}::uuid, ${schoolId}::uuid, ${`blocked-${id}`}) RETURNING id
    `.execute(tx)
      ).rows.length,
    update: async (id, tx) =>
      (
        await sql`
      UPDATE roles SET name = 'blocked-update' WHERE id = ${id}::uuid RETURNING id
    `.execute(tx)
      ).rows.length,
    delete: async (id, tx) =>
      (
        await sql`DELETE FROM roles WHERE id = ${id}::uuid RETURNING id`.execute(
          tx,
        )
      ).rows.length,
  },
  role_permissions: {
    select: async (id, tx) =>
      (
        await sql`
      SELECT role_id FROM role_permissions WHERE role_id = ${id}::uuid AND permission = 'students:read'
    `.execute(tx)
      ).rows.length,
    insert: async (_id, schoolId, tx) =>
      (
        await sql`
      INSERT INTO role_permissions (school_id, role_id, permission)
      VALUES (${schoolId}::uuid, ${fixture.roleBExtra}::uuid, 'analytics:read') RETURNING role_id
    `.execute(tx)
      ).rows.length,
    update: async (id, tx) =>
      (
        await sql`
      UPDATE role_permissions SET permission = 'analytics:read'
      WHERE role_id = ${id}::uuid AND permission = 'students:read' RETURNING role_id
    `.execute(tx)
      ).rows.length,
    delete: async (id, tx) =>
      (
        await sql`
      DELETE FROM role_permissions WHERE role_id = ${id}::uuid AND permission = 'students:read' RETURNING role_id
    `.execute(tx)
      ).rows.length,
  },
  membership_roles: {
    select: async (id, tx) =>
      (
        await sql`
      SELECT membership_id FROM membership_roles WHERE membership_id = ${id}::uuid AND role_id = ${fixture.roleB}::uuid
    `.execute(tx)
      ).rows.length,
    insert: async (_id, schoolId, tx) =>
      (
        await sql`
      INSERT INTO membership_roles (school_id, membership_id, role_id)
      VALUES (${schoolId}::uuid, ${fixture.membershipB}::uuid, ${fixture.roleBExtra}::uuid) RETURNING membership_id
    `.execute(tx)
      ).rows.length,
    update: async (id, tx) =>
      (
        await sql`
      UPDATE membership_roles SET role_id = ${fixture.roleBExtra}::uuid
      WHERE membership_id = ${id}::uuid AND role_id = ${fixture.roleB}::uuid RETURNING membership_id
    `.execute(tx)
      ).rows.length,
    delete: async (id, tx) =>
      (
        await sql`
      DELETE FROM membership_roles WHERE membership_id = ${id}::uuid AND role_id = ${fixture.roleB}::uuid RETURNING membership_id
    `.execute(tx)
      ).rows.length,
  },
  audit_log: {
    select: async (id, tx) =>
      (await sql`SELECT id FROM audit_log WHERE id = ${id}::uuid`.execute(tx))
        .rows.length,
    insert: async (id, schoolId, tx) =>
      (
        await sql`
      INSERT INTO audit_log (id, school_id, user_id, action, resource_type)
      VALUES (${id}::uuid, ${schoolId}::uuid, ${fixture.userB}::uuid, 'probe.insert', 'test') RETURNING id
    `.execute(tx)
      ).rows.length,
    update: async (id, tx) =>
      (
        await sql`
      UPDATE audit_log SET action = 'probe.update' WHERE id = ${id}::uuid RETURNING id
    `.execute(tx)
      ).rows.length,
    delete: async (id, tx) =>
      (
        await sql`DELETE FROM audit_log WHERE id = ${id}::uuid RETURNING id`.execute(
          tx,
        )
      ).rows.length,
  },
};

const probeApi = express();
probeApi.use(express.json());
probeApi.post(
  "/probe/:table/:operation",
  tenantContext,
  asyncHandler(async (request, response) => {
    const table = request.params.table as ProbeTable;
    const operation = request.params.operation as ProbeOperation;
    if (
      !probeTables.includes(table) ||
      !["select", "insert", "update", "delete"].includes(operation)
    ) {
      response
        .status(404)
        .json({ code: "NOT_FOUND", message: "Resource not found" });
      return;
    }
    const body = request.body as { id?: string; schoolId?: string };
    const context = request.tenantContext!;
    const id = body.id ?? "";
    const count =
      operation === "insert"
        ? await probes[table].insert(id, body.schoolId ?? "", context.tx)
        : await probes[table][operation](id, context.tx);
    response.json({ count });
  }),
);
probeApi.use(errorHandler);

async function inAppTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await appPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.school_id', $1, true)", [
      fixture.schoolA,
    ]);
    return await callback(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function inMigrationSchool<T>(
  schoolId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await migrationPool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.school_id', $1, true)", [
      schoolId,
    ]);
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function authorization(token = tokenA): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

async function createFixtures(): Promise<void> {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  await migrationPool.query(
    "INSERT INTO schools (id, name, slug, status) VALUES ($1, $2, $3, $4)",
    [fixture.schoolA, "School A", fixture.slugA, "active"],
  );
  await migrationPool.query(
    "INSERT INTO schools (id, name, slug, status) VALUES ($1, $2, $3, $4)",
    [fixture.schoolB, "School B", fixture.slugB, "active"],
  );
  await migrationPool.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
    [fixture.userA, fixture.emailA, passwordHash],
  );
  await migrationPool.query(
    "INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)",
    [fixture.userB, fixture.emailB, passwordHash],
  );
  await inMigrationSchool(fixture.schoolA, async (client) => {
    await client.query(
      "INSERT INTO memberships (id, school_id, user_id) VALUES ($1, $2, $3)",
      [fixture.membershipA, fixture.schoolA, fixture.userA],
    );
    await client.query(
      "INSERT INTO roles (id, school_id, name) VALUES ($1, $2, $3)",
      [fixture.roleA, fixture.schoolA, "test_reader"],
    );
    await client.query(
      "INSERT INTO role_permissions (school_id, role_id, permission) VALUES ($1, $2, $3)",
      [fixture.schoolA, fixture.roleA, "audit:read"],
    );
    await client.query(
      "INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)",
      [fixture.schoolA, fixture.membershipA, fixture.roleA],
    );
    await client.query(
      "INSERT INTO audit_log (id, school_id, user_id, action, resource_type) VALUES ($1, $2, $3, $4, $5)",
      [fixture.auditA, fixture.schoolA, fixture.userA, "fixture.a", "test"],
    );
  });
  await inMigrationSchool(fixture.schoolB, async (client) => {
    await client.query(
      "INSERT INTO memberships (id, school_id, user_id) VALUES ($1, $2, $3)",
      [fixture.membershipB, fixture.schoolB, fixture.userB],
    );
    await client.query(
      "INSERT INTO roles (id, school_id, name) VALUES ($1, $2, $3)",
      [fixture.roleB, fixture.schoolB, "test_role"],
    );
    await client.query(
      "INSERT INTO roles (id, school_id, name) VALUES ($1, $2, $3)",
      [fixture.roleBExtra, fixture.schoolB, "test_role_extra"],
    );
    await client.query(
      "INSERT INTO role_permissions (school_id, role_id, permission) VALUES ($1, $2, $3)",
      [fixture.schoolB, fixture.roleB, "students:read"],
    );
    await client.query(
      "INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3)",
      [fixture.schoolB, fixture.membershipB, fixture.roleB],
    );
    await client.query(
      "INSERT INTO audit_log (id, school_id, user_id, action, resource_type) VALUES ($1, $2, $3, $4, $5)",
      [fixture.auditB, fixture.schoolB, fixture.userB, "fixture.b", "test"],
    );
  });
  tokenA = createAccessToken({
    userId: fixture.userA,
    schoolId: fixture.schoolA,
    membershipId: fixture.membershipA,
    platformAdmin: false,
  });
}

async function cleanupFixtures(): Promise<void> {
  for (const schoolId of [fixture.schoolA, fixture.schoolB]) {
    await inMigrationSchool(schoolId, async (client) => {
      await client.query("DELETE FROM audit_log WHERE school_id = $1", [
        schoolId,
      ]);
      await client.query("DELETE FROM membership_roles WHERE school_id = $1", [
        schoolId,
      ]);
      await client.query("DELETE FROM role_permissions WHERE school_id = $1", [
        schoolId,
      ]);
      await client.query("DELETE FROM roles WHERE school_id = $1", [schoolId]);
      await client.query("DELETE FROM memberships WHERE school_id = $1", [
        schoolId,
      ]);
    });
  }
  await migrationPool.query(
    "DELETE FROM refresh_tokens WHERE user_id = ANY($1::uuid[])",
    [[fixture.userA, fixture.userB]],
  );
  await migrationPool.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [
    [fixture.userA, fixture.userB],
  ]);
  await migrationPool.query("DELETE FROM schools WHERE id = ANY($1::uuid[])", [
    [fixture.schoolA, fixture.schoolB],
  ]);
}

beforeAll(async () => {
  await createFixtures();
});

afterAll(async () => {
  try {
    await cleanupFixtures();
  } finally {
    await closeDatabase();
    await appPool.end();
    await migrationPool.end();
  }
});

describe("Phase 1 tenant isolation", () => {
  it("requires every application table to be classified and every tenant table to have forced RLS", async () => {
    const tables = await migrationPool.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'
      ORDER BY c.relname
    `);
    const expected = [
      "academic_years",
      "assessments",
      "attendance",
      "attendance_registers",
      "attendance_versions",
      "audit_log",
      "class_subjects",
      "classes",
      "enrollments",
      "grade_bands",
      "grading_scales",
      "grading_scheme_overrides",
      "grading_schemes",
      "guardians",
      "import_jobs",
      "memberships",
      "membership_roles",
      "refresh_tokens",
      "role_permissions",
      "roles",
      "score_versions",
      "scores",
      "scheme_components",
      "school_closures",
      "school_settings",
      "students",
      "student_subject_opt_outs",
      "schools",
      "subjects",
      "teacher_assignments",
      "term_results",
      "term_attendance",
      "term_summaries",
      "terms",
      "users",
    ].sort();
    expect(tables.rows.map((row) => row.relname)).toEqual(expected);

    const policies = await migrationPool.query<{
      relname: string;
      owner_name: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policy_name: string | null;
      using_expression: string | null;
      check_expression: string | null;
    }>(
      `
      SELECT c.relname, pg_get_userbyid(c.relowner) AS owner_name,
        c.relrowsecurity, c.relforcerowsecurity,
        p.policyname AS policy_name, p.qual AS using_expression, p.with_check AS check_expression
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_policies p ON p.schemaname = n.nspname AND p.tablename = c.relname
        AND p.policyname = 'tenant_isolation'
      WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
      ORDER BY c.relname
    `,
      [tenantTables],
    );
    expect(policies.rows).toHaveLength(tenantTables.length);
    for (const policy of policies.rows) {
      expect(policy.relrowsecurity, policy.relname).toBe(true);
      expect(policy.relforcerowsecurity, policy.relname).toBe(true);
      expect(policy.owner_name, policy.relname).not.toBe("arrow_app");
      expect(policy.policy_name, policy.relname).toBe("tenant_isolation");
      expect(policy.using_expression).toContain("app.school_id");
      expect(policy.check_expression).toContain("app.school_id");
    }

    const loginPolicy = await migrationPool.query<{
      cmd: string;
      qual: string;
    }>(`
      SELECT cmd, qual FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'memberships'
        AND policyname = 'login_membership_read'
    `);
    expect(loginPolicy.rows[0]?.cmd).toBe("SELECT");
    expect(loginPolicy.rows[0]?.qual).toContain("app.login_user_id");

    const appRole = await migrationPool.query<{
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'arrow_app'",
    );
    expect(appRole.rows[0]).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
    });
  });

  it("returns zero rows for every tenant table when app.school_id is unset", async () => {
    const client = await appPool.connect();
    try {
      await client.query("BEGIN");
      for (const table of tenantTables) {
        const result = await client.query(
          `SELECT count(*)::int AS count FROM ${table}`,
        );
        expect(result.rows[0].count, table).toBe(0);
      }
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });

  it.each(probeTables)(
    "blocks direct school B SELECT/INSERT/UPDATE/DELETE on %s",
    async (table) => {
      const targetIds: Record<ProbeTable, string> = {
        memberships: fixture.membershipB,
        roles: fixture.roleB,
        role_permissions: fixture.roleB,
        membership_roles: fixture.membershipB,
        audit_log: fixture.auditB,
      };
      const id = targetIds[table];
      const visible = await inAppTransaction(async (client) => {
        const result = await client.query(
          `SELECT * FROM ${table} WHERE school_id = $1`,
          [fixture.schoolB],
        );
        return result.rows;
      });
      expect(visible, `${table} SELECT`).toHaveLength(0);

      await expect(
        inAppTransaction((client) => directInsert(client, table, randomUUID())),
      ).rejects.toMatchObject({ code: "42501" });

      if (table === "audit_log") {
        await expect(
          inAppTransaction((client) => directUpdate(client, table, id)),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          inAppTransaction((client) => directDelete(client, table, id)),
        ).rejects.toMatchObject({ code: "42501" });
      } else {
        const updated = await inAppTransaction((client) =>
          directUpdate(client, table, id),
        );
        expect(updated, `${table} UPDATE`).toHaveLength(0);
        const deleted = await inAppTransaction((client) =>
          directDelete(client, table, id),
        );
        expect(deleted, `${table} DELETE`).toHaveLength(0);
      }
    },
  );

  it.each(probeTables)(
    "blocks school B CRUD through the tenant API transaction on %s",
    async (table) => {
      const targetIds: Record<ProbeTable, string> = {
        memberships: fixture.membershipB,
        roles: fixture.roleB,
        role_permissions: fixture.roleB,
        membership_roles: fixture.membershipB,
        audit_log: fixture.auditB,
      };
      const id = targetIds[table];
      const select = await request(probeApi)
        .post(`/probe/${table}/select`)
        .set(authorization())
        .send({ id });
      expect(select.status).toBe(200);
      expect(select.body.count).toBe(0);

      const insert = await request(probeApi)
        .post(`/probe/${table}/insert`)
        .set(authorization())
        .send({
          id: randomUUID(),
          schoolId: fixture.schoolB,
        });
      expect(insert.status).toBe(500);
      expect(insert.body.code).toBe("INTERNAL_ERROR");

      const update = await request(probeApi)
        .post(`/probe/${table}/update`)
        .set(authorization())
        .send({ id });
      if (table === "audit_log") {
        expect(update.status).toBe(500);
      } else {
        expect(update.status).toBe(200);
        expect(update.body.count).toBe(0);
      }

      const deleted = await request(probeApi)
        .post(`/probe/${table}/delete`)
        .set(authorization())
        .send({ id });
      if (table === "audit_log") {
        expect(deleted.status).toBe(500);
      } else {
        expect(deleted.status).toBe(200);
        expect(deleted.body.count).toBe(0);
      }
    },
  );

  it("returns only the caller school from /me and the audit API", async () => {
    const me = await request(app).get("/api/v1/me").set(authorization());
    expect(me.status).toBe(200);
    expect(me.body.school.id).toBe(fixture.schoolA);

    const audit = await request(app)
      .get("/api/v1/audit-log")
      .set(authorization());
    expect(audit.status).toBe(200);
    expect(audit.body.items.map((row: { id: string }) => row.id)).toContain(
      fixture.auditA,
    );
    expect(audit.body.items.map((row: { id: string }) => row.id)).not.toContain(
      fixture.auditB,
    );
  });

  it("audits a denied users:manage permission check", async () => {
    const denied = await request(app)
      .post("/api/v1/users")
      .set(authorization())
      .send({
        email: `denied-${randomUUID()}@example.test`,
        password,
        roleIds: [fixture.roleA],
      });
    expect(denied.status).toBe(403);
    const audit = await inMigrationSchool(fixture.schoolA, (client) =>
      client.query<{ count: string }>(
        `
      SELECT count(*) FROM audit_log WHERE school_id = $1 AND action = 'authorization.denied'
    `,
        [fixture.schoolA],
      ),
    );
    expect(Number(audit.rows[0]!.count)).toBeGreaterThan(0);
  });

  it("revokes the full refresh-token family when a rotated token is reused", async () => {
    const login = await request(app).post("/api/v1/auth/login").send({
      identifier: fixture.emailA,
      password,
      schoolSlug: fixture.slugA,
    });
    expect(login.status).toBe(200);
    const oldCookie = readRefreshCookie(login.headers["set-cookie"]);
    expect(oldCookie).toBeTruthy();

    const rotated = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", oldCookie!);
    expect(rotated.status).toBe(200);
    const reuse = await request(app)
      .post("/api/v1/auth/refresh")
      .set("Cookie", oldCookie!);
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe("REFRESH_TOKEN_REUSED");

    const tokenHash = createHash("sha256")
      .update(decodeURIComponent(oldCookie!.split("=")[1]!))
      .digest("hex");
    const family = await migrationPool.query<{ live_tokens: string }>(
      `
      WITH RECURSIVE family(id) AS (
        SELECT id FROM refresh_tokens WHERE token_hash = $1
        UNION
        SELECT CASE WHEN token.id = family.id THEN token.replaced_by ELSE token.id END
        FROM refresh_tokens token
        JOIN family ON token.id = family.id OR token.replaced_by = family.id
        WHERE token.replaced_by IS NOT NULL OR token.id = family.id
      )
      SELECT count(*) FILTER (WHERE token.revoked_at IS NULL) AS live_tokens
      FROM refresh_tokens token JOIN family ON family.id = token.id
    `,
      [tokenHash],
    );
    expect(Number(family.rows[0]!.live_tokens)).toBe(0);
  });

  it("lets an admin registered through the API log in after school approval", async () => {
    const slug = `registration-${randomUUID()}`;
    const email = `admin-${slug}@example.test`;
    const teacherEmail = `teacher-${slug}@example.test`;
    const subjectOnlyTeacherEmail = `subject-only-${slug}@example.test`;
    let schoolId: string | undefined;
    let academicYearId: string | undefined;
    let termId: string | undefined;
    let jhsTermId: string | undefined;
    let classId: string | undefined;
    let jhsClassId: string | undefined;
    let subjectId: string | undefined;
    let mathsSubjectId: string | undefined;
    let scienceSubjectId: string | undefined;
    let studentId: string | undefined;
    let jhsStudentId: string | undefined;
    const additionalStudentIds: string[] = [];
    const jhsSubjectIds: string[] = [];
    let teacherUserId: string | undefined;
    let platformAdminUserId: string | undefined;
    let previousPlatformAdmin: { password_hash: string; status: string } | undefined;
    let platformRefreshTokenHash: string | undefined;

    try {
      const platformPasswordHash = await argon2.hash("Platform-test-password-42!");
      const existingPlatformAdmin = await migrationPool.query<{
        id: string;
        password_hash: string;
        status: string;
      }>(
        "SELECT id, password_hash, status FROM users WHERE lower(email) = lower($1)",
        [env.PLATFORM_ADMIN_EMAIL],
      );
      if (existingPlatformAdmin.rows[0]) {
        platformAdminUserId = existingPlatformAdmin.rows[0].id;
        previousPlatformAdmin = {
          password_hash: existingPlatformAdmin.rows[0].password_hash,
          status: existingPlatformAdmin.rows[0].status,
        };
        await migrationPool.query(
          "UPDATE users SET password_hash = $1, status = 'active' WHERE id = $2",
          [platformPasswordHash, platformAdminUserId],
        );
      } else {
        const insertedPlatformAdmin = await migrationPool.query<{ id: string }>(
          "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
          [env.PLATFORM_ADMIN_EMAIL, platformPasswordHash],
        );
        platformAdminUserId = insertedPlatformAdmin.rows[0]!.id;
      }

      const registered = await request(app).post("/api/v1/schools").send({
        name: "Registered School",
        slug,
        email,
        password,
      });
      expect(registered.status).toBe(201);
      schoolId = registered.body.schoolId as string;
      const schemes = await inMigrationSchool(schoolId, (client) =>
        client.query<{ name: string; band_count: number }>(`
          SELECT gs.name, count(gb.id)::int AS band_count
          FROM grading_schemes gs
          LEFT JOIN grade_bands gb ON gb.school_id = gs.school_id AND gb.scheme_id = gs.id
          WHERE gs.school_id = $1
          GROUP BY gs.id
          ORDER BY gs.name
        `, [schoolId]),
      );
      expect(schemes.rows).toEqual([
        { name: "JHS scheme", band_count: 14 },
        { name: "Primary scheme", band_count: 19 },
      ]);

      const pendingLogin = await request(app).post("/api/v1/auth/login").send({
        identifier: email,
        password,
        schoolSlug: slug,
      });
      expect(pendingLogin.status).toBe(403);
      expect(pendingLogin.body.code).toBe("SCHOOL_UNAVAILABLE");

      const platformLogin = await request(app).post("/api/v1/auth/login").send({
        identifier: env.PLATFORM_ADMIN_EMAIL,
        password: "Platform-test-password-42!",
      });
      expect(platformLogin.status).toBe(200);
      const platformCookie = readRefreshCookie(platformLogin.headers["set-cookie"]);
      if (platformCookie) {
        platformRefreshTokenHash = createHash("sha256")
          .update(decodeURIComponent(platformCookie.split("=")[1]!))
          .digest("hex");
      }
      const approval = await request(app)
        .post(`/api/v1/platform/schools/${schoolId}/approve`)
        .set("Authorization", `Bearer ${platformLogin.body.accessToken as string}`)
        .send({});
      expect(approval.status).toBe(200);
      expect(approval.body.school).toMatchObject({ id: schoolId, status: "active" });
      const login = await request(app).post("/api/v1/auth/login").send({
        identifier: email,
        password,
        schoolSlug: slug,
      });
      expect(login.status).toBe(200);

      const me = await request(app)
        .get("/api/v1/me")
        .set("Authorization", `Bearer ${login.body.accessToken}`);
      expect(me.status).toBe(200);
      expect(me.body.school.id).toBe(schoolId);

      const authorization = { Authorization: `Bearer ${login.body.accessToken}` };
      const year = await request(app)
        .post("/api/v1/academic-years")
        .set(authorization)
        .send({ name: "2025-2027", startDate: "2025-09-01", endDate: "2027-07-31" });
      expect(year.status).toBe(201);
      academicYearId = year.body.id as string;
      const roles = await request(app).get("/api/v1/roles").set(authorization);
      expect(roles.status).toBe(200);
      expect(roles.body.items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          name: "class_teacher",
          permissions: expect.arrayContaining(["attendance:write"]),
        }),
        expect.objectContaining({
          name: "subject_teacher",
          permissions: expect.arrayContaining(["scores:write"]),
        }),
      ]));
      const classTeacherRole = roles.body.items.find(
        (role: { name: string }) => role.name === "class_teacher",
      ) as { id: string } | undefined;
      const subjectTeacherRole = roles.body.items.find(
        (role: { name: string }) => role.name === "subject_teacher",
      ) as { id: string } | undefined;
      expect(classTeacherRole).toBeDefined();
      expect(subjectTeacherRole).toBeDefined();

      const term = await request(app)
        .post(`/api/v1/academic-years/${academicYearId}/terms`)
        .set(authorization)
        .send({ name: "Term 1", termNumber: 1, startDate: "2025-09-01", endDate: "2025-12-19" });
      expect(term.status).toBe(201);
      termId = term.body.id as string;

      const classroom = await request(app)
        .post("/api/v1/classes")
        .set(authorization)
        .send({ academicYearId, name: "Basic 1 A", level: 1, stream: "A" });
      expect(classroom.status).toBe(201);
      classId = classroom.body.id as string;

      const subject = await request(app)
        .post("/api/v1/subjects")
        .set(authorization)
        .send({ name: "English", code: `E-${slug.slice(-8)}` });
      expect(subject.status).toBe(201);
      expect(subject.body.isCore).toBe(true);
      subjectId = subject.body.id as string;
      const englishLanguageSubject = await request(app)
        .post("/api/v1/subjects")
        .set(authorization)
        .send({ name: "English Language", code: `EL-${slug.slice(-8)}` });
      expect(englishLanguageSubject.status).toBe(201);
      expect(englishLanguageSubject.body.isCore).toBe(true);
      jhsSubjectIds.push(englishLanguageSubject.body.id as string);

      const classSubject = await request(app)
        .post(`/api/v1/classes/${classId}/subjects`)
        .set(authorization)
        .send({ subjectId });
      expect(classSubject.status).toBe(201);
      const mathsSubject = await request(app)
        .post("/api/v1/subjects")
        .set(authorization)
        .send({ name: "Maths", code: `M-${slug.slice(-8)}` });
      expect(mathsSubject.status).toBe(201);
      mathsSubjectId = mathsSubject.body.id as string;
      const mathsClassSubject = await request(app)
        .post(`/api/v1/classes/${classId}/subjects`)
        .set(authorization)
        .send({ subjectId: mathsSubjectId });
      expect(mathsClassSubject.status).toBe(201);
      const scienceSubject = await request(app)
        .post("/api/v1/subjects")
        .set(authorization)
        .send({ name: "Science", code: `S-${slug.slice(-8)}` });
      expect(scienceSubject.status).toBe(201);
      scienceSubjectId = scienceSubject.body.id as string;
      const scienceClassSubject = await request(app)
        .post(`/api/v1/classes/${classId}/subjects`)
        .set(authorization)
        .send({ subjectId: scienceSubjectId });
      expect(scienceClassSubject.status).toBe(201);

      const student = await request(app)
        .post("/api/v1/students")
        .set(authorization)
        .send({
          admissionNo: `ADM-${slug.slice(-8)}`,
          firstName: "Ama",
          lastName: "Mensah",
          dateOfBirth: "2018-03-14",
          gender: "female",
        });
      expect(student.status).toBe(201);
      studentId = student.body.id as string;

      const studentDetails = await request(app)
        .get(`/api/v1/students/${studentId}`)
        .set(authorization);
      expect(studentDetails.status).toBe(200);
      expect(studentDetails.body.dateOfBirth).toBe("2018-03-14");

      const guardian = await request(app)
        .post(`/api/v1/students/${studentId}/guardians`)
        .set(authorization)
        .send({ name: "Kofi Mensah", relationship: "parent", phone: "+233201234567", isPrimary: true });
      expect(guardian.status).toBe(201);
      const guardians = await request(app)
        .get(`/api/v1/students/${studentId}/guardians`)
        .set(authorization);
      expect(guardians.status).toBe(200);
      expect(guardians.body.items[0].phone).toBe("+233201234567");

      const enrollment = await request(app)
        .post(`/api/v1/students/${studentId}/enrollments`)
        .set(authorization)
        .send({ academicYearId, classId });
      expect(enrollment.status).toBe(201);

      for (const [index, firstName] of ["Kojo", "Abena", "Yaw"].entries()) {
        const created = await request(app)
          .post("/api/v1/students")
          .set(authorization)
          .send({
            admissionNo: `ADM-${slug.slice(-6)}-${index + 2}`,
            firstName,
            lastName: "Mensah",
            dateOfBirth: "2018-03-14",
            gender: index === 1 ? "female" : "male",
          });
        expect(created.status).toBe(201);
        const id = created.body.id as string;
        additionalStudentIds.push(id);
        const enrolled = await request(app)
          .post(`/api/v1/students/${id}/enrollments`)
          .set(authorization)
          .send({ academicYearId, classId });
        expect(enrolled.status).toBe(201);
      }

      const subjectOnlyTeacher = await request(app)
        .post("/api/v1/users")
        .set(authorization)
        .send({
          email: subjectOnlyTeacherEmail,
          password: "Teacher-password-42!",
          roleIds: [subjectTeacherRole!.id],
        });
      expect(subjectOnlyTeacher.status).toBe(201);
      const invalidAllSubjectsAssignment = await request(app)
        .post("/api/v1/teacher-assignments")
        .set(authorization)
        .send({
          membershipId: subjectOnlyTeacher.body.membershipId,
          classId,
          type: "all_subjects",
          academicYearId,
          startDate: "2025-09-01",
        });
      expect(invalidAllSubjectsAssignment.status).toBe(400);
      expect(invalidAllSubjectsAssignment.body.code).toBe(
        "ALL_SUBJECTS_REQUIRES_TEACHER_ROLES",
      );

      const teacher = await request(app)
        .post("/api/v1/users")
        .set(authorization)
        .send({
          email: teacherEmail,
          password: "Teacher-password-42!",
          roleIds: [classTeacherRole!.id, subjectTeacherRole!.id],
        });
      expect(teacher.status).toBe(201);
      teacherUserId = teacher.body.userId as string;
      const assignment = await request(app)
        .post("/api/v1/teacher-assignments")
        .set(authorization)
        .send({
          membershipId: teacher.body.membershipId,
          classId,
          type: "all_subjects",
          academicYearId,
          startDate: "2025-09-01",
        });
      expect(assignment.status).toBe(201);

      const teacherLogin = await request(app).post("/api/v1/auth/login").send({
        identifier: teacherEmail,
        password: "Teacher-password-42!",
        schoolSlug: slug,
      });
      expect(teacherLogin.status).toBe(200);
      const teacherAuthorization = {
        Authorization: `Bearer ${teacherLogin.body.accessToken as string}`,
      };
      const teacherAssessments = await request(app)
        .get(`/api/v1/classes/${classId}/assessments`)
        .set(teacherAuthorization);
      expect(teacherAssessments.status).toBe(200);
      expect(teacherAssessments.body.items).toHaveLength(15);

      const pupilIds = [studentId!, ...additionalStudentIds];
      const englishId = subjectId!;
      const mathsId = mathsSubjectId!;
      const scienceId = scienceSubjectId!;
      const scoreVectors: Record<string, Array<{
        marks: Array<number | null>;
        statuses?: Array<"scored" | "absent" | "excused">;
      }>> = {
        [englishId]: [
          { marks: [12, 10, 14, 9, 70] },
          {
            marks: [15, 12, null, 10, 80],
            statuses: ["scored", "scored", "excused", "scored", "scored"],
          },
          {
            marks: [15, null, 14, 9, 70],
            statuses: ["scored", "absent", "scored", "scored", "scored"],
          },
          { marks: [10, 10, 10, 10, 60] },
        ],
        [mathsId]: [
          { marks: [15, 15, 15, 15, 90] },
          { marks: [10, 10, 10, 10, 45] },
          { marks: [6, 6, 6, 6, 33] },
          { marks: [10, 10, 10, 10, 60] },
        ],
        [scienceId]: [
          { marks: [8, 9, 10, 7, 55] },
          { marks: [12, 12, 12, 12, 60] },
          { marks: [5, 5, 5, 5, 40] },
          { marks: [10, 10, 10, 10, null] },
        ],
      };
      const assessmentIndexes: Record<string, number> = {
        "Class exercise": 0,
        "Group work": 1,
        "Class test": 2,
        "Project work": 3,
        Exam: 4,
      };
      for (const assessment of teacherAssessments.body.items as Array<{
        id: string;
        subjectId: string;
        name: string;
      }>) {
        const markIndex = assessmentIndexes[assessment.name];
        expect(markIndex).toBeDefined();
        const vectors = scoreVectors[assessment.subjectId];
        expect(vectors).toBeDefined();
        const items = pupilIds.flatMap((id, pupilIndex) => {
          const vector = vectors![pupilIndex]!;
          const mark = vector.marks[markIndex!] ?? null;
          if (assessment.subjectId === scienceId && pupilIndex === 3 && markIndex === 4) {
            return [];
          }
          const status = vector.statuses?.[markIndex!] ?? "scored";
          return [{
            clientId: randomUUID(),
            studentId: id,
            ...(mark === null ? {} : { mark }),
            status: mark === null && status === "scored" ? "absent" : status,
          }];
        });
        const saved = await request(app)
          .put(`/api/v1/assessments/${assessment.id}/scores`)
          .set(teacherAuthorization)
          .send({ items });
        expect(saved.status).toBe(200);
      }

      const computed = await request(app)
        .post(`/api/v1/terms/${termId}/compute-results`)
        .set(authorization)
        .send({});
      expect(computed.status).toBe(200);
      const results = await request(app)
        .get(`/api/v1/results?classId=${classId}&termId=${termId}`)
        .set(authorization);
      expect(results.status).toBe(200);
      const resultFor = (pupilId: string, subjectIdForResult: string) =>
        (results.body.items as Array<{
          studentId: string;
          subjectId: string;
          total: number | string | null;
          grades: Record<string, string>;
          subjectPosition: number | null;
        }>).find((row) =>
          row.studentId === pupilId && row.subjectId === subjectIdForResult,
        );
      const expectResultTotal = (
        pupilId: string,
        subjectIdForResult: string,
        total: number | null,
      ) => {
        const result = resultFor(pupilId, subjectIdForResult);
        expect(result).toBeDefined();
        expect(result?.total === null ? null : Number(result?.total)).toBe(total);
      };
      const pupilA = pupilIds[0]!;
      const pupilB = pupilIds[1]!;
      const pupilC = pupilIds[2]!;
      const pupilD = pupilIds[3]!;
      expectResultTotal(pupilA, englishId, 73);
      expect(resultFor(pupilA, englishId)?.grades.letter).toBe("B");
      expectResultTotal(pupilA, mathsId, 95);
      expect(resultFor(pupilA, mathsId)?.grades.letter).toBe("A+");
      expectResultTotal(pupilA, scienceId, 56);
      expectResultTotal(pupilB, englishId, 81);
      expectResultTotal(pupilB, mathsId, 56);
      expectResultTotal(pupilB, scienceId, 70);
      expectResultTotal(pupilC, englishId, 67);
      expectResultTotal(pupilC, mathsId, 37);
      expectResultTotal(pupilC, scienceId, 37);
      expect(resultFor(pupilD, scienceId)).toMatchObject({
        total: null,
        subjectPosition: null,
      });

      const reportCards = await request(app)
        .get(`/api/v1/terms/${termId}/report-cards?classId=${classId}`)
        .set(authorization);
      expect(reportCards.status).toBe(200);
      const reportCardFor = (studentName: string) =>
        (reportCards.body.items as Array<{
          studentName: string;
          aggregate: number | null;
          average: number | null;
          overallPosition: string | null;
        }>).find((item) => item.studentName === studentName);
      expect(reportCardFor("Ama Mensah")).toMatchObject({
        aggregate: 224,
        average: 75,
        overallPosition: "1st",
      });
      expect(reportCardFor("Kojo Mensah")).toMatchObject({
        aggregate: 207,
        overallPosition: "2nd",
      });
      expect(reportCardFor("Abena Mensah")).toMatchObject({
        aggregate: 141,
        overallPosition: "3rd",
      });
      expect(reportCardFor("Yaw Mensah")).toMatchObject({
        aggregate: null,
        overallPosition: null,
      });

      const jhsTerm = await request(app)
        .post(`/api/v1/academic-years/${academicYearId}/terms`)
        .set(authorization)
        .send({ name: "Term 2", termNumber: 2, startDate: "2026-01-05", endDate: "2026-04-10" });
      expect(jhsTerm.status).toBe(201);
      jhsTermId = jhsTerm.body.id as string;
      const jhsClass = await request(app)
        .post("/api/v1/classes")
        .set(authorization)
        .send({ academicYearId, name: "Basic 7 A", level: 7, stream: "A" });
      expect(jhsClass.status).toBe(201);
      jhsClassId = jhsClass.body.id as string;
      const jhsPupil = await request(app)
        .post("/api/v1/students")
        .set(authorization)
        .send({
          admissionNo: `JHS-${slug.slice(-8)}`,
          firstName: "Esi",
          lastName: "JHS",
          dateOfBirth: "2013-03-14",
          gender: "female",
        });
      expect(jhsPupil.status).toBe(201);
      jhsStudentId = jhsPupil.body.id as string;
      const jhsEnrollment = await request(app)
        .post(`/api/v1/students/${jhsStudentId}/enrollments`)
        .set(authorization)
        .send({ academicYearId, classId: jhsClassId });
      expect(jhsEnrollment.status).toBe(201);

      const jhsSubjectNames = [
        "English",
        "Mathematics",
        "Integrated Science",
        "Social Studies",
        "French",
        "Art",
        "ICT",
      ];
      const jhsSubjects: Array<{ id: string; name: string; isCore: boolean }> = [];
      for (const [index, name] of jhsSubjectNames.entries()) {
        let id: string;
        if (name === "English") {
          id = subjectId!;
        } else {
          const createdSubject = await request(app)
            .post("/api/v1/subjects")
            .set(authorization)
            .send({ name, code: `J${index}-${slug.slice(-8)}` });
          expect(createdSubject.status).toBe(201);
          expect(createdSubject.body.isCore).toBe(index < 4);
          id = createdSubject.body.id as string;
          jhsSubjectIds.push(id);
        }
        jhsSubjects.push({ id, name, isCore: index < 4 });
        const assignedSubject = await request(app)
          .post(`/api/v1/classes/${jhsClassId}/subjects`)
          .set(authorization)
          .send({ subjectId: id });
        expect(assignedSubject.status).toBe(201);
      }
      const changedCoreFlag = await request(app)
        .patch(`/api/v1/subjects/${jhsSubjects[0]!.id}`)
        .set(authorization)
        .send({ isCore: false });
      expect(changedCoreFlag.status).toBe(200);
      expect(changedCoreFlag.body.isCore).toBe(false);
      const readinessWithFewerCoreSubjects = await request(app)
        .get(`/api/v1/terms/${jhsTermId}/readiness?classId=${jhsClassId}`)
        .set(authorization);
      expect(readinessWithFewerCoreSubjects.status).toBe(200);
      expect(readinessWithFewerCoreSubjects.body.classes[0].warnings).toContainEqual(
        expect.objectContaining({ code: "FEWER_THAN_FOUR_CORE_SUBJECTS" }),
      );
      const restoredCoreFlag = await request(app)
        .patch(`/api/v1/subjects/${jhsSubjects[0]!.id}`)
        .set(authorization)
        .send({ isCore: true });
      expect(restoredCoreFlag.status).toBe(200);

      const jhsAssessments = await request(app)
        .get(`/api/v1/classes/${jhsClassId}/assessments`)
        .set(authorization);
      expect(jhsAssessments.status).toBe(200);
      const examPercentBySubject: Record<string, number> = {
        English: 20,
        Mathematics: 30,
        "Integrated Science": 40,
        "Social Studies": 0,
        French: 100,
        Art: 90,
        ICT: 80,
      };
      for (const assessment of jhsAssessments.body.items as Array<{
        id: string;
        subjectName: string;
        component: string | null;
        maxMark: string;
      }>) {
        const maxMark = Number(assessment.maxMark);
        const mark = assessment.component === "exam"
          ? Math.round(maxMark * examPercentBySubject[assessment.subjectName]! * 10 / 100) / 10
          : maxMark;
        const saved = await request(app)
          .put(`/api/v1/assessments/${assessment.id}/scores`)
          .set(authorization)
          .send({
            items: [{
              clientId: randomUUID(),
              studentId: jhsStudentId,
              mark,
              status: "scored",
            }],
          });
        expect(saved.status).toBe(200);
      }
      const jhsComputed = await request(app)
        .post(`/api/v1/terms/${jhsTermId}/compute-results`)
        .set(authorization)
        .send({});
      expect(jhsComputed.status).toBe(200);
      const jhsResults = await request(app)
        .get(`/api/v1/results?classId=${jhsClassId}&termId=${jhsTermId}`)
        .set(authorization);
      expect(jhsResults.status).toBe(200);
      const jhsResultRows = jhsResults.body.items as Array<{
        subjectId: string;
        total: number | string | null;
      }>;
      const totalsBySubject = new Map(
        jhsResultRows.map((row) => [row.subjectId, row.total === null ? null : Number(row.total)]),
      );
      const selectedSubjects = [
        ...jhsSubjects.filter((subject) => subject.isCore),
        ...jhsSubjects
          .filter((subject) => !subject.isCore)
          .sort((a, b) => (totalsBySubject.get(b.id) ?? -1) - (totalsBySubject.get(a.id) ?? -1))
          .slice(0, 2),
      ];
      const expectedAggregate = selectedSubjects.reduce(
        (sum, subject) => sum + (totalsBySubject.get(subject.id) ?? 0),
        0,
      );
      const jhsReportCards = await request(app)
        .get(`/api/v1/terms/${jhsTermId}/report-cards?classId=${jhsClassId}`)
        .set(authorization);
      expect(jhsReportCards.status).toBe(200);
      const jhsReportCard = (jhsReportCards.body.items as Array<{
        studentName: string;
        aggregate: number;
        aggregateSubjects: Array<{ subjectId: string }>;
        subjects: Array<{ subjectId: string; countedTowardAggregate: boolean }>;
      }>).find((item) => item.studentName === "Esi JHS");
      expect(jhsReportCard).toBeDefined();
      expect(jhsReportCard?.aggregate).toBe(expectedAggregate);
      expect(jhsReportCard?.aggregateSubjects.map((subject) => subject.subjectId).sort())
        .toEqual(selectedSubjects.map((subject) => subject.id).sort());
      expect(jhsReportCard?.subjects.filter((subject) => subject.countedTowardAggregate))
        .toHaveLength(6);

      const jhsBroadsheet = await request(app)
        .get(`/api/v1/classes/${jhsClassId}/broadsheet?termId=${jhsTermId}`)
        .set(authorization);
      expect(jhsBroadsheet.status).toBe(200);
      expect(jhsBroadsheet.body.items[0].aggregateSubjects.map(
        (subject: { subjectId: string }) => subject.subjectId,
      ).sort()).toEqual(selectedSubjects.map((subject) => subject.id).sort());
      expect(jhsBroadsheet.body.items[0].subjects.filter(
        (subject: { countedTowardAggregate: boolean }) => subject.countedTowardAggregate,
      )).toHaveLength(6);

      const locked = await request(app)
        .post(`/api/v1/terms/${termId}/lock`)
        .set(authorization)
        .send({});
      expect(locked.status).toBe(200);
      const lockedAssessment = (teacherAssessments.body.items as Array<{ id: string }>)[0]!;
      const lockedWrite = await request(app)
        .put(`/api/v1/assessments/${lockedAssessment.id}/scores`)
        .set(teacherAuthorization)
        .send({
          items: [{
            clientId: randomUUID(),
            studentId: pupilA,
            mark: 11,
            status: "scored",
          }],
        });
      expect(lockedWrite.status).toBe(409);
      expect(lockedWrite.body.items).toMatchObject([
        { outcome: "rejected", reason: "TERM_LOCKED" },
      ]);
    } finally {
      if (schoolId) {
        await inMigrationSchool(schoolId, async (client) => {
          const allClassIds = [classId, jhsClassId].filter((id): id is string => id !== undefined);
          const allTermIds = [termId, jhsTermId].filter((id): id is string => id !== undefined);
          await client.query("DELETE FROM audit_log WHERE school_id = $1", [schoolId]);
          await client.query(
            `DELETE FROM score_versions WHERE score_id IN (
              SELECT id FROM scores WHERE assessment_id IN (
                SELECT id FROM assessments WHERE class_id = ANY($1::uuid[])
              )
            )`,
            [allClassIds],
          );
          await client.query(
            `DELETE FROM scores WHERE assessment_id IN (
              SELECT id FROM assessments WHERE class_id = ANY($1::uuid[])
            )`,
            [allClassIds],
          );
          if (allTermIds.length > 0) {
            await client.query("DELETE FROM term_summaries WHERE term_id = ANY($1::uuid[])", [allTermIds]);
            await client.query("DELETE FROM term_results WHERE term_id = ANY($1::uuid[])", [allTermIds]);
            await client.query("DELETE FROM term_attendance WHERE term_id = ANY($1::uuid[])", [allTermIds]);
          }
          if (allClassIds.length > 0) {
            await client.query("DELETE FROM teacher_assignments WHERE class_id = ANY($1::uuid[])", [allClassIds]);
          }
          if (studentId) {
            await client.query("DELETE FROM guardians WHERE student_id = $1", [studentId]);
          }
          if (additionalStudentIds.length > 0) {
            await client.query(
              "DELETE FROM guardians WHERE student_id = ANY($1::uuid[])",
              [additionalStudentIds],
            );
          }
          const allStudentIds = [studentId, jhsStudentId, ...additionalStudentIds].filter(
            (id): id is string => id !== undefined,
          );
          await client.query("DELETE FROM enrollments WHERE student_id = ANY($1::uuid[])", [allStudentIds]);
          await client.query("DELETE FROM students WHERE id = ANY($1::uuid[])", [allStudentIds]);
          if (allClassIds.length > 0) {
            await client.query("DELETE FROM assessments WHERE class_id = ANY($1::uuid[])", [allClassIds]);
            await client.query("DELETE FROM class_subjects WHERE class_id = ANY($1::uuid[])", [allClassIds]);
          }
          if (allTermIds.length > 0) {
            await client.query("DELETE FROM terms WHERE id = ANY($1::uuid[])", [allTermIds]);
          }
          if (allClassIds.length > 0) {
            await client.query("DELETE FROM classes WHERE id = ANY($1::uuid[])", [allClassIds]);
          }
          const allSubjectIds = [subjectId, mathsSubjectId, scienceSubjectId, ...jhsSubjectIds].filter(
            (id): id is string => id !== undefined,
          );
          await client.query("DELETE FROM subjects WHERE id = ANY($1::uuid[])", [allSubjectIds]);
          if (academicYearId) {
            await client.query("DELETE FROM academic_years WHERE id = $1", [academicYearId]);
          }
          if (teacherUserId) {
            await client.query("DELETE FROM memberships WHERE user_id = $1", [teacherUserId]);
          }
          await client.query("DELETE FROM grade_bands WHERE school_id = $1", [schoolId]);
          await client.query("DELETE FROM grading_scheme_overrides WHERE school_id = $1", [schoolId]);
          await client.query("DELETE FROM grading_schemes WHERE school_id = $1", [schoolId]);
          await client.query("DELETE FROM membership_roles WHERE school_id = $1", [schoolId]);
          await client.query("DELETE FROM role_permissions WHERE school_id = $1", [schoolId]);
          await client.query("DELETE FROM roles WHERE school_id = $1", [schoolId]);
          await client.query("DELETE FROM memberships WHERE school_id = $1", [schoolId]);
        });
        await migrationPool.query(
          "DELETE FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = $1)",
          [email],
        );
        await migrationPool.query(
          "DELETE FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = $1)",
          [teacherEmail],
        );
        await migrationPool.query(
          "DELETE FROM refresh_tokens WHERE user_id = (SELECT id FROM users WHERE email = $1)",
          [subjectOnlyTeacherEmail],
        );
        await migrationPool.query("DELETE FROM users WHERE email = $1", [email]);
        await migrationPool.query("DELETE FROM users WHERE email = $1", [teacherEmail]);
        await migrationPool.query("DELETE FROM users WHERE email = $1", [subjectOnlyTeacherEmail]);
        await migrationPool.query("DELETE FROM schools WHERE id = $1", [schoolId]);
      }
      if (platformRefreshTokenHash) {
        await migrationPool.query(
          "DELETE FROM refresh_tokens WHERE token_hash = $1",
          [platformRefreshTokenHash],
        );
      }
      if (platformAdminUserId) {
        if (previousPlatformAdmin) {
          await migrationPool.query(
            "UPDATE users SET password_hash = $1, status = $2 WHERE id = $3",
            [
              previousPlatformAdmin.password_hash,
              previousPlatformAdmin.status,
              platformAdminUserId,
            ],
          );
        } else {
          await migrationPool.query("DELETE FROM users WHERE id = $1", [platformAdminUserId]);
        }
      }
    }
  });
});

async function directUpdate(
  client: PoolClient,
  table: TenantTable,
  id: string,
): Promise<Array<{ id: string }>> {
  if (table === "memberships") {
    return (
      await client.query(
        "UPDATE memberships SET status = $1 WHERE id = $2 RETURNING id",
        ["disabled", id],
      )
    ).rows;
  }
  if (table === "roles") {
    return (
      await client.query(
        "UPDATE roles SET name = $1 WHERE id = $2 RETURNING id",
        ["blocked", id],
      )
    ).rows;
  }
  if (table === "role_permissions") {
    return (
      await client.query(
        `UPDATE role_permissions SET permission = 'analytics:read' WHERE role_id = $1 AND permission = 'students:read' RETURNING role_id AS id`,
        [id],
      )
    ).rows;
  }
  if (table === "membership_roles") {
    return (
      await client.query(
        "UPDATE membership_roles SET role_id = $1 WHERE membership_id = $2 AND role_id = $3 RETURNING membership_id AS id",
        [fixture.roleBExtra, id, fixture.roleB],
      )
    ).rows;
  }
  return client
    .query("UPDATE audit_log SET action = $1 WHERE id = $2 RETURNING id", [
      "blocked",
      id,
    ])
    .then((result) => result.rows);
}

async function directDelete(
  client: PoolClient,
  table: TenantTable,
  id: string,
): Promise<Array<{ id: string }>> {
  if (table === "memberships") {
    return (
      await client.query("DELETE FROM memberships WHERE id = $1 RETURNING id", [
        id,
      ])
    ).rows;
  }
  if (table === "roles") {
    return (
      await client.query("DELETE FROM roles WHERE id = $1 RETURNING id", [id])
    ).rows;
  }
  if (table === "role_permissions") {
    return (
      await client.query(
        `DELETE FROM role_permissions WHERE role_id = $1 AND permission = 'students:read' RETURNING role_id AS id`,
        [id],
      )
    ).rows;
  }
  if (table === "membership_roles") {
    return (
      await client.query(
        "DELETE FROM membership_roles WHERE membership_id = $1 AND role_id = $2 RETURNING membership_id AS id",
        [id, fixture.roleB],
      )
    ).rows;
  }
  return client
    .query("DELETE FROM audit_log WHERE id = $1 RETURNING id", [id])
    .then((result) => result.rows);
}

function readRefreshCookie(
  headers: string | string[] | undefined,
): string | undefined {
  const setCookie = Array.isArray(headers) ? headers[0] : headers;
  return setCookie?.split(";")[0];
}

async function directInsert(
  client: PoolClient,
  table: TenantTable,
  id: string,
): Promise<Array<{ id: string }>> {
  if (table === "memberships") {
    return (
      await client.query(
        "INSERT INTO memberships (id, school_id, user_id) VALUES ($1, $2, $3) RETURNING id",
        [id, fixture.schoolB, fixture.userB],
      )
    ).rows;
  }
  if (table === "roles") {
    return (
      await client.query(
        "INSERT INTO roles (id, school_id, name) VALUES ($1, $2, $3) RETURNING id",
        [id, fixture.schoolB, `blocked-${id}`],
      )
    ).rows;
  }
  if (table === "role_permissions") {
    return (
      await client.query(
        "INSERT INTO role_permissions (school_id, role_id, permission) VALUES ($1, $2, $3) RETURNING role_id AS id",
        [fixture.schoolB, fixture.roleBExtra, "analytics:read"],
      )
    ).rows;
  }
  if (table === "membership_roles") {
    return (
      await client.query(
        "INSERT INTO membership_roles (school_id, membership_id, role_id) VALUES ($1, $2, $3) RETURNING membership_id AS id",
        [fixture.schoolB, fixture.membershipB, fixture.roleBExtra],
      )
    ).rows;
  }
  return (
    await client.query(
      "INSERT INTO audit_log (id, school_id, user_id, action, resource_type) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [id, fixture.schoolB, fixture.userB, "probe.insert", "test"],
    )
  ).rows;
}

import { createHash, randomUUID } from "node:crypto";
import express from "express";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { Pool, type PoolClient } from "pg";
import { sql, type Transaction } from "kysely";
import { app } from "../src/app";
import { createAccessToken } from "../src/auth/token";
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
    let schoolId: string | undefined;
    let academicYearId: string | undefined;
    let termId: string | undefined;
    let classId: string | undefined;
    let subjectId: string | undefined;
    let studentId: string | undefined;

    try {
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

      await migrationPool.query(
        "UPDATE schools SET status = 'active' WHERE id = $1",
        [schoolId],
      );
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
        .send({ name: "2025-2026", startDate: "2025-09-01", endDate: "2026-07-31" });
      expect(year.status).toBe(201);
      academicYearId = year.body.id as string;

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
        .send({ name: "Mathematics", code: `M-${slug.slice(-8)}` });
      expect(subject.status).toBe(201);
      subjectId = subject.body.id as string;

      const classSubject = await request(app)
        .post(`/api/v1/classes/${classId}/subjects`)
        .set(authorization)
        .send({ subjectId });
      expect(classSubject.status).toBe(201);

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
    } finally {
      if (schoolId) {
        await inMigrationSchool(schoolId, async (client) => {
          await client.query("DELETE FROM audit_log WHERE school_id = $1", [schoolId]);
          if (studentId) {
            await client.query("DELETE FROM guardians WHERE student_id = $1", [studentId]);
            await client.query("DELETE FROM enrollments WHERE student_id = $1", [studentId]);
            await client.query("DELETE FROM students WHERE id = $1", [studentId]);
          }
          if (classId) {
            await client.query("DELETE FROM class_subjects WHERE class_id = $1", [classId]);
          }
          if (termId) {
            await client.query("DELETE FROM terms WHERE id = $1", [termId]);
          }
          if (classId) {
            await client.query("DELETE FROM classes WHERE id = $1", [classId]);
          }
          if (subjectId) {
            await client.query("DELETE FROM subjects WHERE id = $1", [subjectId]);
          }
          if (academicYearId) {
            await client.query("DELETE FROM academic_years WHERE id = $1", [academicYearId]);
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
        await migrationPool.query("DELETE FROM users WHERE email = $1", [email]);
        await migrationPool.query("DELETE FROM schools WHERE id = $1", [schoolId]);
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

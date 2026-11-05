import argon2 from "argon2";
import { sql, type Transaction } from "kysely";
import { seedDefaultGradingSchemes } from "../academics/seeds";
import { recordAudit } from "../audit/service";
import type { Database } from "../shared/db/database";
import { defaultRolePermissions } from "../shared/rbac/permissions";

export interface RegisterSchoolInput {
  name: string;
  slug: string;
  region?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  password: string;
}

export interface RegisteredSchool {
  id: string;
  adminUserId: string;
  status: "pending";
}

export async function seedDefaultRoles(
  tx: Transaction<Database>,
  schoolId: string,
): Promise<void> {
  for (const [name, rolePermissions] of Object.entries(
    defaultRolePermissions,
  )) {
    const role = await sql<{ id: string }>`
      INSERT INTO roles (school_id, name, is_system)
      VALUES (${schoolId}::uuid, ${name}, true)
      RETURNING id
    `.execute(tx);
    const roleId = role.rows[0]!.id;

    for (const permission of rolePermissions) {
      await sql`
        INSERT INTO role_permissions (school_id, role_id, permission)
        VALUES (${schoolId}::uuid, ${roleId}::uuid, ${permission})
      `.execute(tx);
    }
  }
}

export async function registerSchool(
  tx: Transaction<Database>,
  input: RegisterSchoolInput,
): Promise<RegisteredSchool> {
  const passwordHash = await argon2.hash(input.password, {
    type: argon2.argon2id,
  });
  const school = await sql<{ id: string }>`
    INSERT INTO schools (name, slug, region)
    VALUES (${input.name}, ${input.slug}, ${input.region ?? null})
    RETURNING id
  `.execute(tx);
  const schoolId = school.rows[0]!.id;

  const user = await sql<{ id: string }>`
    INSERT INTO users (email, phone, password_hash)
    VALUES (${input.email ?? null}, ${input.phone ?? null}, ${passwordHash})
    RETURNING id
  `.execute(tx);
  const userId = user.rows[0]!.id;

  await sql`SELECT
    set_config('app.school_id', ${schoolId}, true),
    set_config('app.user_id', ${userId}, true)
  `.execute(tx);

  await seedDefaultGradingSchemes(tx, schoolId);

  const membership = await sql<{ id: string }>`
    INSERT INTO memberships (school_id, user_id)
    VALUES (${schoolId}::uuid, ${userId}::uuid)
    RETURNING id
  `.execute(tx);
  const membershipId = membership.rows[0]!.id;

  await seedDefaultRoles(tx, schoolId);
  await sql`
    INSERT INTO membership_roles (school_id, membership_id, role_id)
    SELECT ${schoolId}::uuid, ${membershipId}::uuid, id
    FROM roles
    WHERE school_id = ${schoolId}::uuid AND name = 'school_admin'
  `.execute(tx);
  await recordAudit(tx, {
    schoolId,
    userId,
    action: "school.registered",
    resourceType: "school",
    resourceId: schoolId,
  });

  return { id: schoolId, adminUserId: userId, status: "pending" };
}

import { Router } from "express";
import argon2 from "argon2";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { asyncHandler } from "../shared/middleware/async-handler";
import { requirePermission } from "../shared/middleware/require-permission";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";
import { HttpError } from "../shared/errors/http-error";

const userSchema = z
  .object({
    email: z.string().trim().email().toLowerCase().optional(),
    phone: z.string().trim().min(7).max(24).optional(),
    password: z.string().min(12).max(128),
    roleIds: z.array(z.string().uuid()).min(1).max(20),
  })
  .strict()
  .refine((value) => value.email !== undefined || value.phone !== undefined, {
    message: "Provide an email or phone number",
    path: ["email"],
  });

export const peopleRoutes = Router();

peopleRoutes.get(
  "/me",
  tenantContext,
  asyncHandler(async (request, response) => {
    const { tx, claims } = (request as RequestWithTenant).tenantContext;
    const account = await sql<{
      id: string;
      email: string | null;
      phone: string | null;
      school_id: string;
      school_name: string;
      school_slug: string;
      school_status: string;
    }>`
    SELECT u.id, u.email, u.phone, s.id AS school_id, s.name AS school_name,
      s.slug AS school_slug, s.status AS school_status
    FROM users u
    JOIN schools s ON s.id = ${claims.schoolId!}::uuid
    WHERE u.id = ${claims.userId}::uuid
  `.execute(tx);
    const user = account.rows[0];
    if (!user) {
      throw new HttpError(404, "NOT_FOUND", "User not found");
    }

    const roles = await sql<{ name: string }>`
    SELECT r.name
    FROM membership_roles mr
    JOIN roles r ON r.school_id = mr.school_id AND r.id = mr.role_id
    WHERE mr.school_id = ${claims.schoolId!}::uuid
      AND mr.membership_id = ${claims.membershipId!}::uuid
    ORDER BY r.name
  `.execute(tx);
    const permissions = await sql<{ permission: string }>`
    SELECT DISTINCT rp.permission
    FROM membership_roles mr
    JOIN role_permissions rp ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
    WHERE mr.school_id = ${claims.schoolId!}::uuid
      AND mr.membership_id = ${claims.membershipId!}::uuid
    ORDER BY rp.permission
  `.execute(tx);

    response.json({
      user: { id: user.id, email: user.email, phone: user.phone },
      school: {
        id: user.school_id,
        name: user.school_name,
        slug: user.school_slug,
        status: user.school_status,
      },
      roles: roles.rows.map((row) => row.name),
      permissions: permissions.rows.map((row) => row.permission),
    });
  }),
);

peopleRoutes.post(
  "/users",
  tenantContext,
  requirePermission("users:manage"),
  asyncHandler(async (request, response) => {
    const parsed = userSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        parsed.error.issues,
      );
    }
    const tenantRequest = request as RequestWithTenant;
    const { tx, claims } = tenantRequest.tenantContext;
    const roleIds = [...new Set(parsed.data.roleIds)];
    const roles = await sql<{ id: string }>`
      SELECT id FROM roles
      WHERE school_id = ${claims.schoolId!}::uuid
        AND id = ANY(${roleIds}::uuid[])
    `.execute(tx);
    if (roles.rows.length !== roleIds.length) {
      throw new HttpError(404, "NOT_FOUND", "One or more roles were not found");
    }

    const passwordHash = await argon2.hash(parsed.data.password, {
      type: argon2.argon2id,
    });
    const user = await sql<{ id: string }>`
      INSERT INTO users (email, phone, password_hash)
      VALUES (${parsed.data.email ?? null}, ${parsed.data.phone ?? null}, ${passwordHash})
      RETURNING id
    `.execute(tx);
    const userId = user.rows[0]!.id;
    const membership = await sql<{ id: string }>`
      INSERT INTO memberships (school_id, user_id)
      VALUES (${claims.schoolId!}::uuid, ${userId}::uuid)
      RETURNING id
    `.execute(tx);
    const membershipId = membership.rows[0]!.id;

    for (const roleId of roleIds) {
      await sql`
        INSERT INTO membership_roles (school_id, membership_id, role_id)
        VALUES (${claims.schoolId!}::uuid, ${membershipId}::uuid, ${roleId}::uuid)
      `.execute(tx);
    }
    await recordAudit(tx, {
      schoolId: claims.schoolId!,
      userId: claims.userId,
      action: "user.created",
      resourceType: "user",
      resourceId: userId,
      metadata: { membershipId, roleIds },
    });
    response.status(201).json({ userId, membershipId });
  }),
);

peopleRoutes.get(
  "/roles",
  tenantContext,
  requirePermission("users:read"),
  asyncHandler(async (request, response) => {
    const { tx } = (request as RequestWithTenant).tenantContext;
    const roles = await sql<{
      id: string;
      name: string;
      permissions: string[];
    }>`
      SELECT r.id, r.name,
        coalesce(array_agg(rp.permission ORDER BY rp.permission)
          FILTER (WHERE rp.permission IS NOT NULL), '{}') AS permissions
      FROM roles r
      LEFT JOIN role_permissions rp
        ON rp.school_id = r.school_id AND rp.role_id = r.id
      GROUP BY r.id, r.name
      ORDER BY r.name
    `.execute(tx);
    response.json({ items: roles.rows });
  }),
);

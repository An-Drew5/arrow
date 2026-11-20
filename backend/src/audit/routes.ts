import { Router } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { asyncHandler } from "../shared/middleware/async-handler";
import { requirePermission } from "../shared/middleware/require-permission";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";
import { HttpError } from "../shared/errors/http-error";

const paginationSchema = z
  .object({
    page: z.coerce.number().int().min(1).max(10000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const auditRoutes = Router();

auditRoutes.get(
  "/audit-log",
  tenantContext,
  requirePermission("audit:read"),
  asyncHandler(async (request, response) => {
    const parsed = paginationSchema.safeParse(request.query);
    if (!parsed.success) {
      throw new HttpError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        parsed.error.issues,
      );
    }
    const { page, limit } = parsed.data;
    const { tx, claims } = (request as RequestWithTenant).tenantContext;
    const rows = await sql<{
      id: string;
      user_id: string | null;
      action: string;
      resource_type: string;
      resource_id: string | null;
      reason: string | null;
      metadata: Record<string, unknown>;
      created_at: Date;
    }>`
    SELECT id, user_id, action, resource_type, resource_id, reason, metadata, created_at
    FROM audit_log
    WHERE school_id = ${claims.schoolId!}::uuid
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1} OFFSET ${(page - 1) * limit}
  `.execute(tx);
    const hasMore = rows.rows.length > limit;
    response.json({
      items: rows.rows.slice(0, limit),
      page,
      limit,
      nextPage: hasMore ? page + 1 : null,
    });
  }),
);

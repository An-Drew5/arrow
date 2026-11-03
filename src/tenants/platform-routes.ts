import { Router, type Request } from "express";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { verifyAccessToken, type AccessClaims } from "../auth/token";
import { db } from "../shared/db/database";
import { HttpError } from "../shared/errors/http-error";
import { asyncHandler } from "../shared/middleware/async-handler";

type PlatformRequest = Request & { platformClaims: AccessClaims };

const schoolIdSchema = z.string().uuid();
const actionBodySchema = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

function requirePlatformAdmin(
  request: Request,
  response: import("express").Response,
  next: import("express").NextFunction,
): void {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;
  if (!token) {
    response
      .status(401)
      .json({ code: "UNAUTHORIZED", message: "Authentication required" });
    return;
  }
  try {
    const claims = verifyAccessToken(token);
    if (!claims.platformAdmin) {
      response
        .status(403)
        .json({
          code: "FORBIDDEN",
          message: "Platform administrator access required",
        });
      return;
    }
    (request as PlatformRequest).platformClaims = claims;
    next();
  } catch {
    response
      .status(401)
      .json({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
}

export const platformRoutes = Router();

platformRoutes.post(
  "/schools/:id/approve",
  requirePlatformAdmin,
  asyncHandler(async (request, response) => {
    await updateSchoolStatus(request, response, "active", "school.approved");
  }),
);

platformRoutes.post(
  "/schools/:id/suspend",
  requirePlatformAdmin,
  asyncHandler(async (request, response) => {
    await updateSchoolStatus(
      request,
      response,
      "suspended",
      "school.suspended",
    );
  }),
);

async function updateSchoolStatus(
  request: Request,
  response: import("express").Response,
  status: "active" | "suspended",
  action: string,
): Promise<void> {
  const id = schoolIdSchema.safeParse(request.params.id);
  const body = actionBodySchema.safeParse(request.body ?? {});
  if (!id.success || !body.success) {
    throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", [
      ...(!id.success ? id.error.issues : []),
      ...(!body.success ? body.error.issues : []),
    ]);
  }

  const claims = (request as PlatformRequest).platformClaims;
  const school = await db.transaction().execute(async (tx) => {
    const existing = await sql<{ id: string; name: string; status: string }>`
      SELECT id, name, status FROM schools WHERE id = ${id.data}::uuid FOR UPDATE
    `.execute(tx);
    const current = existing.rows[0];
    if (!current) {
      throw new HttpError(404, "NOT_FOUND", "School not found");
    }
    const result = await sql<{ id: string; name: string; status: string }>`
      UPDATE schools SET status = ${status}
      WHERE id = ${current.id}::uuid
      RETURNING id, name, status
    `.execute(tx);
    const updated = result.rows[0]!;

    await sql`SELECT
      set_config('app.school_id', ${updated.id}, true),
      set_config('app.user_id', ${claims.userId}, true)
    `.execute(tx);
    await recordAudit(tx, {
      schoolId: updated.id,
      userId: claims.userId,
      action,
      resourceType: "school",
      resourceId: updated.id,
      ...(body.data.reason ? { reason: body.data.reason } : {}),
      metadata: { previousStatus: current.status },
    });
    return updated;
  });
  response.json({
    school: { id: school.id, name: school.name, status: school.status },
  });
}

import type { NextFunction, Request, Response } from "express";
import { sql } from "kysely";
import { verifyAccessToken } from "../../auth/token";
import { db } from "../db/database";
import { HttpError } from "../errors/http-error";
import type { TenantContext } from "./request-context";

class RollbackRequest extends Error {}

function sendUnauthorized(response: Response): void {
  response
    .status(401)
    .json({ code: "UNAUTHORIZED", message: "Authentication required" });
}

export async function tenantContext(
  request: Request,
  response: Response,
  next: NextFunction,
): Promise<void> {
  const authorization = request.header("authorization");
  const token = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : undefined;

  if (!token) {
    sendUnauthorized(response);
    return;
  }

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch {
    sendUnauthorized(response);
    return;
  }

  if (!claims.schoolId || !claims.membershipId) {
    sendUnauthorized(response);
    return;
  }

  try {
    await db.transaction().execute(async (tx) => {
      const context: TenantContext = { tx, claims, rollback: false };
      request.tenantContext = context;

      await sql`SELECT
        set_config('app.school_id', ${claims.schoolId}, true),
        set_config('app.user_id', ${claims.userId}, true)
      `.execute(tx);

      const membership = await sql<{ active: boolean }>`
        SELECT (m.status = 'active' AND s.status = 'active') AS active
        FROM memberships m
        JOIN schools s ON s.id = m.school_id
        WHERE m.id = ${claims.membershipId}::uuid
          AND m.school_id = ${claims.schoolId}::uuid
          AND m.user_id = ${claims.userId}::uuid
        LIMIT 1
      `.execute(tx);

      if (!membership.rows[0]?.active) {
        sendUnauthorized(response);
        return;
      }

      const finished = new Promise<void>((resolve) => {
        response.once("finish", resolve);
        response.once("close", resolve);
      });
      next();
      await finished;
      if (context.rollback || !response.writableFinished) {
        throw new RollbackRequest();
      }
    });
  } catch (error) {
    if (error instanceof RollbackRequest) {
      return;
    }
    next(
      error instanceof HttpError
        ? error
        : new HttpError(500, "INTERNAL_ERROR", "Request failed"),
    );
  }
}

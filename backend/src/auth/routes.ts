import { Router, type Response } from "express";
import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import rateLimit from "express-rate-limit";
import { sql } from "kysely";
import { z } from "zod";
import { recordAudit } from "../audit/service";
import { asyncHandler } from "../shared/middleware/async-handler";
import { db } from "../shared/db/database";
import { env } from "../shared/config/env";
import { HttpError } from "../shared/errors/http-error";
import { tenantContext } from "../shared/middleware/tenant-context";
import type { RequestWithTenant } from "../shared/middleware/request-context";
import { login, logout, rotateRefreshToken } from "./service";

const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(128),
    schoolSlug: z.string().trim().toLowerCase().min(1).max(80).optional(),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().min(12).max(128),
}).strict();
const resetPasswordSchema = z.object({
  resetToken: z.string().regex(/^[0-9a-f]{64}$/),
  newPassword: z.string().min(12).max(128),
}).strict();
const cookieName = "arrow_refresh";
const cookiePath = "/api/v1/auth";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "RATE_LIMITED", message: "Too many login attempts" },
});
const resetPasswordLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "RATE_LIMITED", message: "Too many password reset attempts" },
});

export const authRoutes = Router();

authRoutes.post(
  "/change-password",
  tenantContext,
  asyncHandler(async (request, response) => {
    const parsed = changePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
    }
    const { tx, claims } = (request as RequestWithTenant).tenantContext;
    const user = await sql<{ password_hash: string }>`
      SELECT password_hash FROM users WHERE id = ${claims.userId}::uuid FOR UPDATE
    `.execute(tx);
    if (!user.rows[0] || !(await argon2.verify(user.rows[0].password_hash, parsed.data.currentPassword))) {
      throw new HttpError(401, "INVALID_CREDENTIALS", "Current password is incorrect");
    }
    const passwordHash = await argon2.hash(parsed.data.newPassword, { type: argon2.argon2id });
    await sql`
      UPDATE users
      SET password_hash = ${passwordHash},
        password_reset_token_hash = NULL,
        password_reset_expires_at = NULL,
        password_reset_school_id = NULL,
        password_reset_issued_by = NULL
      WHERE id = ${claims.userId}::uuid
    `.execute(tx);
    await sql`
      UPDATE refresh_tokens SET revoked_at = now()
      WHERE user_id = ${claims.userId}::uuid AND revoked_at IS NULL
    `.execute(tx);
    await recordAudit(tx, {
      schoolId: claims.schoolId!,
      userId: claims.userId,
      action: "user.password_changed",
      resourceType: "user",
      resourceId: claims.userId,
    });
    response.status(204).end();
  }),
);

authRoutes.post(
  "/reset-password",
  resetPasswordLimiter,
  asyncHandler(async (request, response) => {
    const parsed = resetPasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new HttpError(400, "VALIDATION_ERROR", "Request validation failed", parsed.error.issues);
    }
    const tokenHash = createHash("sha256").update(parsed.data.resetToken).digest("hex");
    await db.transaction().execute(async (tx) => {
      const target = await sql<{
        id: string;
        school_id: string;
        issued_by: string;
      }>`
        SELECT id, password_reset_school_id AS school_id,
          password_reset_issued_by AS issued_by
        FROM users
        WHERE password_reset_token_hash = ${tokenHash}
          AND password_reset_expires_at > now()
        FOR UPDATE
      `.execute(tx);
      const user = target.rows[0];
      if (!user) {
        throw new HttpError(401, "INVALID_RESET_TOKEN", "Reset token is invalid or expired");
      }
      const passwordHash = await argon2.hash(parsed.data.newPassword, { type: argon2.argon2id });
      await sql`
        UPDATE users
        SET password_hash = ${passwordHash},
          password_reset_token_hash = NULL,
          password_reset_expires_at = NULL,
          password_reset_school_id = NULL,
          password_reset_issued_by = NULL
        WHERE id = ${user.id}::uuid AND password_reset_token_hash = ${tokenHash}
      `.execute(tx);
      await sql`
        UPDATE refresh_tokens SET revoked_at = now()
        WHERE user_id = ${user.id}::uuid AND revoked_at IS NULL
      `.execute(tx);
      await sql`SELECT
        set_config('app.school_id', ${user.school_id}, true),
        set_config('app.user_id', ${user.id}, true)
      `.execute(tx);
      await recordAudit(tx, {
        schoolId: user.school_id,
        userId: user.id,
        action: "user.password_reset_completed",
        resourceType: "user",
        resourceId: user.id,
        metadata: { issuedBy: user.issued_by },
      });
    });
    response.status(204).end();
  }),
);

authRoutes.post("/login", loginLimiter, async (request, response, next) => {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    next(
      new HttpError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        parsed.error.issues,
      ),
    );
    return;
  }

  try {
    const outcome = await db.transaction().execute(async (tx) => {
      try {
        return { result: await login(tx, parsed.data) };
      } catch (error) {
        if (error instanceof HttpError) {
          return { error };
        }
        throw error;
      }
    });
    if ("error" in outcome) {
      next(outcome.error);
      return;
    }
    const result = outcome.result;
    if (result.kind === "choose_school") {
      response
        .status(200)
        .json({ requiresSchoolSelection: true, schools: result.schools });
      return;
    }
    setRefreshCookie(response, result.refreshToken);
    response.status(200).json({
      accessToken: result.accessToken,
      ...(result.school ? { school: result.school } : {}),
    });
  } catch (error) {
    next(error);
  }
});

authRoutes.post("/refresh", async (request, response, next) => {
  const parsed = emptyBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    next(
      new HttpError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        parsed.error.issues,
      ),
    );
    return;
  }
  const token = readRefreshCookie(request.headers.cookie);
  if (!token) {
    response.status(401).json({
      code: "INVALID_REFRESH_TOKEN",
      message: "Refresh token is required",
    });
    return;
  }

  try {
    const outcome = await db.transaction().execute(async (tx) => {
      try {
        return { result: await rotateRefreshToken(tx, token) };
      } catch (error) {
        if (error instanceof HttpError) {
          return { error };
        }
        throw error;
      }
    });
    if ("error" in outcome) {
      clearRefreshCookie(response);
      next(outcome.error);
      return;
    }
    setRefreshCookie(response, outcome.result.refreshToken);
    response.status(200).json({ accessToken: outcome.result.accessToken });
  } catch (error) {
    next(error);
  }
});

authRoutes.post("/logout", async (request, response, next) => {
  const parsed = emptyBodySchema.safeParse(request.body ?? {});
  if (!parsed.success) {
    next(
      new HttpError(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        parsed.error.issues,
      ),
    );
    return;
  }
  try {
    await db
      .transaction()
      .execute((tx) => logout(tx, readRefreshCookie(request.headers.cookie)));
    clearRefreshCookie(response);
    response.status(204).end();
  } catch (error) {
    next(error);
  }
});

function readRefreshCookie(
  cookieHeader: string | undefined,
): string | undefined {
  const cookie = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  if (!cookie) {
    return undefined;
  }
  try {
    return decodeURIComponent(cookie.slice(cookieName.length + 1));
  } catch {
    return undefined;
  }
}

function setRefreshCookie(response: Response, token: string): void {
  response.cookie(cookieName, token, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: cookiePath,
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

function clearRefreshCookie(response: Response): void {
  response.clearCookie(cookieName, {
    httpOnly: true,
    secure: env.NODE_ENV === "production",
    sameSite: "strict",
    path: cookiePath,
  });
}

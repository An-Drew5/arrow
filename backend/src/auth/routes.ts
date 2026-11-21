import { Router, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "../shared/db/database";
import { env } from "../shared/config/env";
import { HttpError } from "../shared/errors/http-error";
import { login, logout, rotateRefreshToken } from "./service";

const loginSchema = z
  .object({
    identifier: z.string().trim().min(1).max(254),
    password: z.string().min(1).max(128),
    schoolSlug: z.string().trim().toLowerCase().min(1).max(80).optional(),
  })
  .strict();
const emptyBodySchema = z.object({}).strict();
const cookieName = "arrow_refresh";
const cookiePath = "/api/v1/auth";

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "RATE_LIMITED", message: "Too many login attempts" },
});

export const authRoutes = Router();

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
    response
      .status(401)
      .json({
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

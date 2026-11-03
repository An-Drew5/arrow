import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "../shared/db/database";
import { HttpError } from "../shared/errors/http-error";
import { registerSchool } from "./service";

const registrationSchema = z
  .object({
    name: z.string().trim().min(2).max(160),
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
      .max(80),
    region: z.string().trim().max(120).optional(),
    email: z.string().trim().email().toLowerCase().optional(),
    phone: z.string().trim().min(7).max(24).optional(),
    password: z.string().min(12).max(128),
  })
  .refine((value) => value.email !== undefined || value.phone !== undefined, {
    message: "Provide an email or phone number",
    path: ["email"],
  });

const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: "RATE_LIMITED", message: "Too many registration attempts" },
});

export const tenantRoutes = Router();

tenantRoutes.post(
  "/schools",
  registrationLimiter,
  async (request, response, next) => {
    const parsed = registrationSchema.safeParse(request.body);
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
      const result = await db
        .transaction()
        .execute((tx) => registerSchool(tx, parsed.data));
      response.status(201).json({ schoolId: result.id, status: result.status });
    } catch (error) {
      if (isUniqueViolation(error)) {
        next(
          new HttpError(
            409,
            "CONFLICT",
            "School slug, email, or phone is already registered",
          ),
        );
        return;
      }
      next(error);
    }
  },
);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

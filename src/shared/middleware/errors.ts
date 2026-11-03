import type { ErrorRequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError } from "../errors/http-error";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  request,
  response,
  _next,
) => {
  if (request.tenantContext) {
    request.tenantContext.rollback = true;
  }

  if (error instanceof ZodError) {
    response.status(400).json({
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: error.issues.map(({ path, message }) => ({ path, message })),
    });
    return;
  }

  if (error instanceof HttpError) {
    response.status(error.status).json({
      code: error.code,
      message: error.message,
      ...(error.details === undefined
        ? {}
        : {
            details:
              error.code === "VALIDATION_ERROR"
                ? safeValidationDetails(error.details)
                : error.details,
          }),
    });
    return;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    response
      .status(400)
      .json({
        code: "INVALID_JSON",
        message: "Request body must be valid JSON",
      });
    return;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 413
  ) {
    response
      .status(413)
      .json({
        code: "PAYLOAD_TOO_LARGE",
        message: "Request body is too large",
      });
    return;
  }

  response
    .status(500)
    .json({ code: "INTERNAL_ERROR", message: "Request failed" });
};

function safeValidationDetails(
  details: unknown,
): Array<{ path: unknown[]; message: string }> {
  if (!Array.isArray(details)) {
    return [];
  }
  return details.map((issue: unknown) => {
    if (typeof issue !== "object" || issue === null) {
      return { path: [], message: "Invalid value" };
    }
    const candidate = issue as { path?: unknown; message?: unknown };
    return {
      path: Array.isArray(candidate.path) ? candidate.path : [],
      message:
        typeof candidate.message === "string"
          ? candidate.message
          : "Invalid value",
    };
  });
}

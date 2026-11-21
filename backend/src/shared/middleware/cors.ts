import type { RequestHandler } from "express";

export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (request, response, next) => {
    const origin = request.header("origin");
    if (!origin) {
      if (request.method === "OPTIONS") {
        response.status(204).end();
        return;
      }
      next();
      return;
    }
    if (!allowed.has(origin)) {
      response.status(403).json({
        code: "CORS_ORIGIN_DENIED",
        message: "Origin is not allowed",
      });
      return;
    }

    response.vary("Origin");
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Credentials", "true");
    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PATCH, PUT, DELETE, OPTIONS",
    );
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  };
}

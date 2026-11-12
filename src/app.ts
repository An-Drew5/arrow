import express from "express";
import { authRoutes } from "./auth/routes";
import { auditRoutes } from "./audit/routes";
import { academicsRoutes } from "./academics/routes";
import { academicCoreRoutes } from "./academics/core-routes";
import { attendanceRoutes } from "./academics/attendance-routes";
import { teacherRoutes } from "./academics/teacher-routes";
import { schoolRoutes } from "./academics/school-routes";
import { academicResourceScope } from "./academics/scope";
import { peopleRoutes } from "./people/routes";
import { db } from "./shared/db/database";
import { errorHandler } from "./shared/middleware/errors";
import { setResourceScopeRule } from "./shared/rbac/can";
import { redis } from "./shared/queue/redis";
import { platformRoutes } from "./tenants/platform-routes";
import { tenantRoutes } from "./tenants/routes";

export const app = express();
setResourceScopeRule(academicResourceScope);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use("/api/v1", tenantRoutes);
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1", peopleRoutes);
app.use("/api/v1", auditRoutes);
app.use("/api/v1", academicsRoutes);
app.use("/api/v1", academicCoreRoutes);
app.use("/api/v1", attendanceRoutes);
app.use("/api/v1", teacherRoutes);
app.use("/api/v1", schoolRoutes);
app.use("/api/v1/platform", platformRoutes);

app.get("/api/v1/health", async (_request, response) => {
  const checks: Record<string, "ok" | "error"> = {
    postgres: "error",
    redis: "error",
  };

  try {
    await db
      .selectNoFrom((expression) => expression.val(1).as("healthy"))
      .execute();
    checks.postgres = "ok";
  } catch {
    // Health responses expose status only, never connection details.
  }

  try {
    await redis.ping();
    checks.redis = "ok";
  } catch {
    // Health responses expose status only, never connection details.
  }

  const healthy = Object.values(checks).every((status) => status === "ok");
  response
    .status(healthy ? 200 : 503)
    .json({ status: healthy ? "ok" : "error", checks });
});

app.use((_request, response) => {
  response
    .status(404)
    .json({ code: "NOT_FOUND", message: "Resource not found" });
});

app.use(errorHandler);

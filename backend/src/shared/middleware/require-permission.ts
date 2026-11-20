import type { RequestHandler } from "express";
import { can } from "../rbac/can";
import type { Permission } from "../rbac/permissions";
import { recordAudit } from "../../audit/service";
import type { RequestWithTenant } from "./request-context";

export function requirePermission(permission: Permission): RequestHandler {
  return (request, response, next) => {
    const tenantRequest = request as RequestWithTenant;
    const context = tenantRequest.tenantContext;
    if (!context) {
      response
        .status(401)
        .json({ code: "UNAUTHORIZED", message: "Authentication required" });
      return;
    }

    void can(
      {
        userId: context.claims.userId,
        schoolId: context.claims.schoolId!,
        membershipId: context.claims.membershipId!,
      },
      permission,
      context.tx,
    )
      .then(async (allowed) => {
        if (allowed) {
          next();
          return;
        }

        await recordAudit(context.tx, {
          schoolId: context.claims.schoolId!,
          userId: context.claims.userId,
          action: "authorization.denied",
          resourceType: "permission",
          metadata: { permission },
        });
        response
          .status(403)
          .json({ code: "FORBIDDEN", message: "Permission denied" });
      })
      .catch(next);
  };
}

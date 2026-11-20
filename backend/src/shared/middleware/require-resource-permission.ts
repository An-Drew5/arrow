import type { Request, RequestHandler } from "express";
import { can, type ResourceReference } from "../rbac/can";
import type { Permission } from "../rbac/permissions";
import { recordAudit } from "../../audit/service";
import { HttpError } from "../errors/http-error";
import type { RequestWithTenant } from "./request-context";

export function requireResourcePermission(
  permission: Permission,
  resolveResource: (request: Request) => ResourceReference,
): RequestHandler {
  return (request, response, next) => {
    const context = (request as RequestWithTenant).tenantContext;
    if (!context) {
      response.status(401).json({ code: "UNAUTHORIZED", message: "Authentication required" });
      return;
    }
    const resource = resolveResource(request);
    void can(
      {
        userId: context.claims.userId,
        schoolId: context.claims.schoolId!,
        membershipId: context.claims.membershipId!,
      },
      permission,
      context.tx,
      resource,
    ).then(async (allowed) => {
      if (allowed) {
        next();
        return;
      }
      await recordAudit(context.tx, {
        schoolId: context.claims.schoolId!,
        userId: context.claims.userId,
        action: "authorization.denied",
        resourceType: resource.type,
        resourceId: resource.id,
        metadata: { permission },
      });
      next(new HttpError(404, "NOT_FOUND", "Resource not found"));
    }).catch(next);
  };
}
import type { Transaction } from "kysely";
import type { Request } from "express";
import type { AccessClaims } from "../../auth/token";
import type { Database } from "../db/database";

export interface TenantContext {
  tx: Transaction<Database>;
  claims: AccessClaims;
  rollback: boolean;
}

declare global {
  namespace Express {
    interface Request {
      tenantContext?: TenantContext;
    }
  }
}

export type RequestWithTenant = Request & { tenantContext: TenantContext };

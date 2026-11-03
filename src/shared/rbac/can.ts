import { sql, type Transaction } from "kysely";
import type { Permission } from "./permissions";
import type { Database } from "../db/database";

export interface Actor {
  userId: string;
  schoolId: string;
  membershipId: string;
}

export interface ResourceReference {
  type: string;
  id: string;
}

export type ResourceScopeRule = (
  actor: Actor,
  permission: Permission,
  resource: ResourceReference,
  tx: Transaction<Database>,
) => Promise<boolean>;

let resourceScopeRule: ResourceScopeRule | undefined;

export function setResourceScopeRule(
  rule: ResourceScopeRule | undefined,
): void {
  resourceScopeRule = rule;
}

export async function can(
  actor: Actor,
  permission: Permission,
  tx: Transaction<Database>,
  resource?: ResourceReference,
): Promise<boolean> {
  const result = await sql<{ allowed: boolean }>`
    SELECT EXISTS (
      SELECT 1
      FROM membership_roles mr
      JOIN role_permissions rp
        ON rp.school_id = mr.school_id AND rp.role_id = mr.role_id
      WHERE mr.school_id = ${actor.schoolId}::uuid
        AND mr.membership_id = ${actor.membershipId}::uuid
        AND rp.permission = ${permission}
    ) AS allowed
  `.execute(tx);

  if (!result.rows[0]?.allowed) {
    return false;
  }
  if (resource && resourceScopeRule) {
    return resourceScopeRule(actor, permission, resource, tx);
  }
  return true;
}

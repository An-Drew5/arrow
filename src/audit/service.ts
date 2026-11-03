import { sql, type Transaction } from "kysely";
import type { Database } from "../shared/db/database";

export interface AuditEntry {
  schoolId: string;
  userId: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(
  tx: Transaction<Database>,
  entry: AuditEntry,
): Promise<void> {
  await sql`
    INSERT INTO audit_log
      (school_id, user_id, action, resource_type, resource_id, reason, metadata)
    VALUES (
      ${entry.schoolId}::uuid,
      ${entry.userId}::uuid,
      ${entry.action},
      ${entry.resourceType},
      ${entry.resourceId ?? null}::uuid,
      ${entry.reason ?? null},
      ${JSON.stringify(entry.metadata ?? {})}::jsonb
    )
  `.execute(tx);
}

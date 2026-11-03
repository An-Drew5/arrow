import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { env } from "../config/env";

export interface Database {
  [table: string]: Record<string, unknown>;
}

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({
    pool: new Pool({ connectionString: env.DATABASE_URL }),
  }),
});

export async function closeDatabase(): Promise<void> {
  await db.destroy();
}

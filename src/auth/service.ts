import { createHash, randomBytes } from "node:crypto";
import argon2 from "argon2";
import { sql, type Transaction } from "kysely";
import { recordAudit } from "../audit/service";
import { env } from "../shared/config/env";
import type { Database } from "../shared/db/database";
import { HttpError } from "../shared/errors/http-error";
import { createAccessToken } from "./token";

export interface LoginInput {
  identifier: string;
  password: string;
  schoolSlug?: string | undefined;
}

export type LoginResult =
  | { kind: "choose_school"; schools: Array<{ slug: string; name: string }> }
  | {
      kind: "authenticated";
      accessToken: string;
      refreshToken: string;
      school?: { id: string; name: string; slug: string };
    };

interface LoginRow {
  user_id: string;
  email: string | null;
  password_hash: string;
  user_status: string;
  membership_id: string | null;
  school_id: string | null;
  school_slug: string | null;
  school_name: string | null;
  school_status: string | null;
  membership_status: string | null;
}

type LoginUserRow = Pick<
  LoginRow,
  "user_id" | "email" | "password_hash" | "user_status"
>;
type LoginMembershipRow = Omit<LoginRow, keyof LoginUserRow>;

interface StoredRefreshToken {
  id: string;
  user_id: string;
  expires_at: Date;
  revoked_at: Date | null;
}

function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function schoolContext(
  schoolId: string,
  userId: string,
  tx: Transaction<Database>,
) {
  return sql`SELECT
    set_config('app.school_id', ${schoolId}, true),
    set_config('app.user_id', ${userId}, true)
  `.execute(tx);
}

function makeRefreshToken(schoolId?: string, membershipId?: string): string {
  const secret = randomBytes(32).toString("base64url");
  return schoolId && membershipId
    ? `${schoolId}.${membershipId}.${secret}`
    : `platform.${secret}`;
}

async function insertRefreshToken(
  tx: Transaction<Database>,
  userId: string,
  refreshToken: string,
): Promise<string> {
  const result = await sql<{ id: string }>`
    INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
    VALUES (
      ${userId}::uuid,
      ${hashRefreshToken(refreshToken)},
      now() + (${env.REFRESH_TOKEN_TTL_DAYS} * interval '1 day')
    )
    RETURNING id
  `.execute(tx);
  return result.rows[0]!.id;
}

async function writeFailedLoginAudit(
  tx: Transaction<Database>,
  rows: LoginRow[],
): Promise<void> {
  const seenSchools = new Set<string>();
  for (const row of rows) {
    if (!row.school_id || seenSchools.has(row.school_id)) {
      continue;
    }
    seenSchools.add(row.school_id);
    await schoolContext(row.school_id, row.user_id, tx);
    await recordAudit(tx, {
      schoolId: row.school_id,
      userId: row.user_id,
      action: "auth.login_failed",
      resourceType: "auth",
    });
  }
}

export async function login(
  tx: Transaction<Database>,
  input: LoginInput,
): Promise<LoginResult> {
  const identifier = input.identifier.trim().toLowerCase();
  const userResult = await sql<LoginUserRow>`
    SELECT id AS user_id, email, password_hash, status AS user_status
    FROM users
    WHERE lower(email) = ${identifier} OR phone = ${input.identifier.trim()}
    ORDER BY created_at
    LIMIT 1
  `.execute(tx);
  const found = userResult.rows[0];

  let rows: LoginRow[] = [];
  if (found) {
    await sql`SELECT set_config('app.login_user_id', ${found.user_id}, true)`
      .execute(tx);
    const membershipResult = await sql<LoginMembershipRow>`
      SELECT
        m.id AS membership_id,
        s.id AS school_id,
        s.slug AS school_slug,
        s.name AS school_name,
        s.status AS school_status,
        m.status AS membership_status
      FROM memberships m
      JOIN schools s ON s.id = m.school_id
      WHERE m.user_id = ${found.user_id}::uuid
      ORDER BY s.slug
    `.execute(tx);
    rows =
      membershipResult.rows.length > 0
        ? membershipResult.rows.map((membership) => ({ ...found, ...membership }))
        : [
            {
              ...found,
              membership_id: null,
              school_id: null,
              school_slug: null,
              school_name: null,
              school_status: null,
              membership_status: null,
            },
          ];
  }
  const user = rows[0];

  let passwordValid = false;
  if (user) {
    try {
      passwordValid = await argon2.verify(user.password_hash, input.password);
    } catch {
      passwordValid = false;
    }
  }

  if (!user || !passwordValid || user.user_status !== "active") {
    await writeFailedLoginAudit(tx, rows);
    console.warn("Authentication failed");
    throw new HttpError(
      401,
      "INVALID_CREDENTIALS",
      "Email/phone or password is incorrect",
    );
  }

  const platformAdmin =
    user.email?.toLowerCase() === env.PLATFORM_ADMIN_EMAIL.toLowerCase();
  const memberships = rows.filter((row) => row.school_id && row.membership_id);

  if (memberships.length === 0 && platformAdmin) {
    const refreshToken = makeRefreshToken();
    await insertRefreshToken(tx, user.user_id, refreshToken);
    return {
      kind: "authenticated",
      accessToken: createAccessToken({
        userId: user.user_id,
        platformAdmin: true,
      }),
      refreshToken,
    };
  }

  if (memberships.length === 0) {
    throw new HttpError(
      401,
      "INVALID_CREDENTIALS",
      "Email/phone or password is incorrect",
    );
  }

  if (!input.schoolSlug && memberships.length > 1) {
    return {
      kind: "choose_school",
      schools: memberships.map((row) => ({
        slug: row.school_slug!,
        name: row.school_name!,
      })),
    };
  }

  const selected = input.schoolSlug
    ? memberships.find((row) => row.school_slug === input.schoolSlug)
    : memberships[0];
  if (!selected?.school_id || !selected.membership_id) {
    throw new HttpError(404, "NOT_FOUND", "School membership not found");
  }
  if (
    selected.school_status !== "active" ||
    selected.membership_status !== "active"
  ) {
    throw new HttpError(
      403,
      "SCHOOL_UNAVAILABLE",
      "This school is not available for login",
    );
  }

  await schoolContext(selected.school_id, user.user_id, tx);
  const refreshToken = makeRefreshToken(
    selected.school_id,
    selected.membership_id,
  );
  await insertRefreshToken(tx, user.user_id, refreshToken);
  await recordAudit(tx, {
    schoolId: selected.school_id,
    userId: user.user_id,
    action: "auth.login_succeeded",
    resourceType: "auth",
  });

  return {
    kind: "authenticated",
    accessToken: createAccessToken({
      userId: user.user_id,
      schoolId: selected.school_id,
      membershipId: selected.membership_id,
      platformAdmin,
    }),
    refreshToken,
    school: {
      id: selected.school_id,
      name: selected.school_name!,
      slug: selected.school_slug!,
    },
  };
}

function refreshTokenContext(token: string): {
  schoolId?: string;
  membershipId?: string;
} {
  const parts = token.split(".");
  if (parts[0] === "platform" && parts.length === 2) {
    return {};
  }
  if (
    parts.length === 3 &&
    /^[0-9a-f-]{36}$/i.test(parts[0]!) &&
    /^[0-9a-f-]{36}$/i.test(parts[1]!)
  ) {
    return { schoolId: parts[0]!, membershipId: parts[1]! };
  }
  throw new HttpError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid");
}

async function revokeFamily(
  tx: Transaction<Database>,
  tokenId: string,
): Promise<void> {
  await sql`
    WITH RECURSIVE family(id) AS (
      SELECT id FROM refresh_tokens WHERE id = ${tokenId}::uuid
      UNION
      SELECT CASE WHEN token.id = family.id THEN token.replaced_by ELSE token.id END
      FROM refresh_tokens token
      JOIN family ON token.id = family.id OR token.replaced_by = family.id
      WHERE token.replaced_by IS NOT NULL OR token.id = family.id
    )
    UPDATE refresh_tokens
    SET revoked_at = COALESCE(revoked_at, now())
    WHERE id IN (SELECT id FROM family)
  `.execute(tx);
}

export interface RefreshResult {
  accessToken: string;
  refreshToken: string;
}

export async function rotateRefreshToken(
  tx: Transaction<Database>,
  token: string,
): Promise<RefreshResult> {
  const context = refreshTokenContext(token);
  const result = await sql<StoredRefreshToken>`
    SELECT id, user_id, expires_at, revoked_at
    FROM refresh_tokens
    WHERE token_hash = ${hashRefreshToken(token)}
    FOR UPDATE
  `.execute(tx);
  const stored = result.rows[0];
  if (!stored) {
    throw new HttpError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Refresh token is invalid",
    );
  }

  if (stored.revoked_at) {
    if (context.schoolId) {
      await schoolContext(context.schoolId, stored.user_id, tx);
    }
    await revokeFamily(tx, stored.id);
    if (context.schoolId) {
      await recordAudit(tx, {
        schoolId: context.schoolId,
        userId: stored.user_id,
        action: "auth.refresh_reuse_detected",
        resourceType: "refresh_token",
        resourceId: stored.id,
      });
    }
    throw new HttpError(
      401,
      "REFRESH_TOKEN_REUSED",
      "Refresh token reuse detected",
    );
  }

  if (stored.expires_at <= new Date()) {
    await revokeFamily(tx, stored.id);
    throw new HttpError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Refresh token is expired",
    );
  }

  if (context.schoolId && context.membershipId) {
    await schoolContext(context.schoolId, stored.user_id, tx);
    const membership = await sql<{
      active: boolean;
      school_name: string | null;
    }>`
      SELECT (m.status = 'active' AND s.status = 'active') AS active, s.name AS school_name
      FROM memberships m
      JOIN schools s ON s.id = m.school_id
      WHERE m.id = ${context.membershipId}::uuid
        AND m.school_id = ${context.schoolId}::uuid
        AND m.user_id = ${stored.user_id}::uuid
    `.execute(tx);
    if (!membership.rows[0]?.active) {
      await revokeFamily(tx, stored.id);
      throw new HttpError(
        401,
        "INVALID_REFRESH_TOKEN",
        "Refresh token is no longer valid",
      );
    }
  }

  const admin = await sql<{ valid: boolean }>`
      SELECT lower(email) = lower(${env.PLATFORM_ADMIN_EMAIL}) AS valid
      FROM users WHERE id = ${stored.user_id}::uuid
    `.execute(tx);
  const platformAdmin = admin.rows[0]?.valid === true;
  if (!context.schoolId && !platformAdmin) {
    throw new HttpError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Refresh token is invalid",
    );
  }

  const nextToken = makeRefreshToken(context.schoolId, context.membershipId);
  const nextId = await insertRefreshToken(tx, stored.user_id, nextToken);
  await sql`
    UPDATE refresh_tokens SET revoked_at = now(), replaced_by = ${nextId}::uuid
    WHERE id = ${stored.id}::uuid AND revoked_at IS NULL
  `.execute(tx);

  if (context.schoolId) {
    await recordAudit(tx, {
      schoolId: context.schoolId,
      userId: stored.user_id,
      action: "auth.refresh_rotated",
      resourceType: "refresh_token",
      resourceId: stored.id,
    });
  }

  const accessToken = createAccessToken({
    userId: stored.user_id,
    platformAdmin,
    ...(context.schoolId ? { schoolId: context.schoolId } : {}),
    ...(context.membershipId ? { membershipId: context.membershipId } : {}),
  });
  return { accessToken, refreshToken: nextToken };
}

export async function logout(
  tx: Transaction<Database>,
  token: string | undefined,
): Promise<void> {
  if (!token) {
    return;
  }
  const context = refreshTokenContext(token);
  const result = await sql<StoredRefreshToken>`
    SELECT id, user_id, expires_at, revoked_at
    FROM refresh_tokens
    WHERE token_hash = ${hashRefreshToken(token)}
    FOR UPDATE
  `.execute(tx);
  const stored = result.rows[0];
  if (!stored) {
    return;
  }
  await revokeFamily(tx, stored.id);
  if (context.schoolId) {
    await schoolContext(context.schoolId, stored.user_id, tx);
    await recordAudit(tx, {
      schoolId: context.schoolId,
      userId: stored.user_id,
      action: "auth.logout",
      resourceType: "refresh_token",
      resourceId: stored.id,
    });
  }
}

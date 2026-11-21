import jwt, { type JwtPayload } from "jsonwebtoken";
import { env } from "../shared/config/env";

export interface AccessClaims {
  userId: string;
  schoolId?: string;
  membershipId?: string;
  platformAdmin: boolean;
}

export function createAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    subject: claims.userId,
    expiresIn: env.JWT_ACCESS_TTL_SECONDS,
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET);
  if (!decoded || typeof decoded === "string") {
    throw new Error("Invalid access token");
  }

  const payload = decoded as JwtPayload & Partial<AccessClaims>;
  if (
    typeof payload.sub !== "string" ||
    typeof payload.platformAdmin !== "boolean" ||
    (payload.schoolId !== undefined && typeof payload.schoolId !== "string") ||
    (payload.membershipId !== undefined &&
      typeof payload.membershipId !== "string")
  ) {
    throw new Error("Invalid access token");
  }

  return {
    userId: payload.sub,
    platformAdmin: payload.platformAdmin,
    ...(payload.schoolId ? { schoolId: payload.schoolId } : {}),
    ...(payload.membershipId ? { membershipId: payload.membershipId } : {}),
  };
}

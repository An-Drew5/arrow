export const permissions = [
  "school:manage",
  "academics:manage",
  "users:manage",
  "users:read",
  "roles:manage",
  "audit:read",
  "students:read",
  "students:write",
  "scores:read",
  "scores:write",
  "attendance:read",
  "attendance:write",
  "analytics:read",
  "grading:manage",
  "settings:manage",
  "results:compute",
  "terms:lock",
  "reports:read",
  "imports:run",
] as const;

export type Permission = (typeof permissions)[number];

export function isPermission(value: string): value is Permission {
  return (permissions as readonly string[]).includes(value);
}

export const defaultRolePermissions: Record<string, readonly Permission[]> = {
  school_admin: permissions,
  headteacher: [
    "students:read",
    "scores:read",
    "attendance:read",
    "reports:read",
    "terms:lock",
    "results:compute",
  ],
  class_teacher: [
    "students:read",
    "scores:read",
    "attendance:read",
    "attendance:write",
  ],
  subject_teacher: ["students:read", "scores:read", "scores:write"],
  records_officer: [
    "students:read",
    "students:write",
    "attendance:read",
    "imports:run",
  ],
  accountant: ["students:read", "analytics:read"],
};

export const permissions = [
  "school:manage",
  "users:manage",
  "roles:manage",
  "audit:read",
  "students:read",
  "students:write",
  "scores:read",
  "scores:write",
  "attendance:write",
  "analytics:read",
  "grading:manage",
] as const;

export type Permission = (typeof permissions)[number];

export function isPermission(value: string): value is Permission {
  return (permissions as readonly string[]).includes(value);
}

export const defaultRolePermissions: Record<string, readonly Permission[]> = {
  school_admin: permissions,
  headteacher: [
    "school:manage",
    "users:manage",
    "roles:manage",
    "audit:read",
    "students:read",
    "students:write",
    "scores:read",
    "scores:write",
    "attendance:write",
    "analytics:read",
    "grading:manage",
  ],
  class_teacher: [
    "students:read",
    "students:write",
    "scores:read",
    "scores:write",
    "attendance:write",
    "analytics:read",
  ],
  subject_teacher: [
    "students:read",
    "scores:read",
    "scores:write",
    "analytics:read",
    "grading:manage",
  ],
  records_officer: [
    "students:read",
    "students:write",
    "scores:read",
    "attendance:write",
    "audit:read",
  ],
  accountant: ["students:read", "analytics:read"],
};

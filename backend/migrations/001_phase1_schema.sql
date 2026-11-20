CREATE TABLE schools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  region text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'suspended')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE,
  phone text UNIQUE,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  UNIQUE (school_id, user_id),
  UNIQUE (school_id, id)
);
CREATE INDEX memberships_school_status_idx ON memberships (school_id, status);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  name text NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  UNIQUE (school_id, name),
  UNIQUE (school_id, id)
);

CREATE TABLE role_permissions (
  school_id uuid NOT NULL,
  role_id uuid NOT NULL,
  permission text NOT NULL,
  PRIMARY KEY (school_id, role_id, permission),
  FOREIGN KEY (school_id, role_id) REFERENCES roles (school_id, id) ON DELETE CASCADE
);

CREATE TABLE membership_roles (
  school_id uuid NOT NULL,
  membership_id uuid NOT NULL,
  role_id uuid NOT NULL,
  PRIMARY KEY (school_id, membership_id, role_id),
  FOREIGN KEY (school_id, membership_id) REFERENCES memberships (school_id, id) ON DELETE CASCADE,
  FOREIGN KEY (school_id, role_id) REFERENCES roles (school_id, id) ON DELETE CASCADE
);

CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id, expires_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id uuid NOT NULL REFERENCES schools(id),
  user_id uuid REFERENCES users(id),
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (school_id, id)
);
CREATE INDEX audit_log_school_created_idx ON audit_log (school_id, created_at DESC, id DESC);

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON memberships
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roles
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_permissions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON role_permissions
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE membership_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE membership_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON membership_roles
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_log
  USING (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid)
  WITH CHECK (school_id = NULLIF(current_setting('app.school_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public TO arrow_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON schools, users, memberships, roles, role_permissions, membership_roles, refresh_tokens TO arrow_app;
GRANT SELECT, INSERT ON audit_log TO arrow_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM arrow_app;
-- Branch defaults narrow discovery; they never grant facility access.
CREATE TABLE company_branches (
 id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
 organization_id uuid NOT NULL REFERENCES organizations(id),
 name text NOT NULL CHECK (btrim(name) <> ''),
 default_state text NOT NULL CHECK (default_state ~ '^[A-Z]{2}$'),
 default_territory text CHECK (default_territory IS NULL OR btrim(default_territory) <> ''),
 is_active boolean NOT NULL DEFAULT true,
 UNIQUE(organization_id,id), UNIQUE(organization_id,name)
);
CREATE TABLE user_branch_assignments (
 user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 branch_id uuid NOT NULL,
 assigned_by_user_id uuid NOT NULL REFERENCES users(id),
 assigned_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (organization_id,branch_id) REFERENCES company_branches(organization_id,id)
);
ALTER TABLE company_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_branch_assignments ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON company_branches,user_branch_assignments FROM anon; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN REVOKE ALL ON company_branches,user_branch_assignments FROM authenticated; END IF;
END $$;
CREATE INDEX user_branch_assignments_branch_idx ON user_branch_assignments(branch_id);

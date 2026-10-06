"""row-level security, app role grants, login lookup function"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

# NULLIF: after a transaction that used set_config(..., true) ends, the setting reads back
# as '' rather than NULL. Without NULLIF the uuid cast would raise instead of matching nothing.
CURRENT_ORG = "NULLIF(current_setting('app.current_org_id', true), '')::uuid"

# users is ENABLEd but not FORCEd: auth_find_user is SECURITY DEFINER owned by the table
# owner and must be able to read users before any tenant is known.
FORCED = {"organizations", "accounts", "transactions", "audit_log"}
TENANT_COLUMN = {
    "organizations": "id",
    "users": "org_id",
    "accounts": "org_id",
    "transactions": "org_id",
    "audit_log": "org_id",
}


def upgrade() -> None:
    for table, column in TENANT_COLUMN.items():
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        if table in FORCED:
            op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table}"
            f" USING ({column} = {CURRENT_ORG}) WITH CHECK ({column} = {CURRENT_ORG})"
        )

    op.execute(
        """
        CREATE FUNCTION auth_find_user(p_email citext)
        RETURNS TABLE (id uuid, org_id uuid, password_hash text, role text, is_active boolean)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
            SELECT u.id, u.org_id, u.password_hash, u.role, u.is_active
            FROM users u WHERE u.email = p_email;
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION auth_find_user(citext) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION auth_find_user(citext) TO portal_app")

    op.execute("GRANT USAGE ON SCHEMA public TO portal_app")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON"
        " organizations, users, accounts, transactions, audit_log TO portal_app"
    )
    op.execute("GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO portal_app")


def downgrade() -> None:
    op.execute("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM portal_app")
    op.execute("REVOKE ALL ON SEQUENCE audit_log_id_seq FROM portal_app")
    op.execute("DROP FUNCTION auth_find_user(citext)")
    for table in TENANT_COLUMN:
        op.execute(f"DROP POLICY tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

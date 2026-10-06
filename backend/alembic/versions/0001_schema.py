"""tables, constraints, indexes"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    """
    CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        plan text NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise')),
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id),
        email citext NOT NULL UNIQUE,
        password_hash text NOT NULL,
        full_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'member')),
        is_active boolean NOT NULL DEFAULT true,
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, id)
    )
    """,
    """
    CREATE TABLE accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id),
        name text NOT NULL,
        status text NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
        tier text NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
        monthly_value numeric(12,2) NOT NULL CHECK (monthly_value >= 0),
        owner_user_id uuid,
        opened_at date NOT NULL,
        closed_at date,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, id),
        FOREIGN KEY (org_id, owner_user_id) REFERENCES users (org_id, id)
    )
    """,
    """
    CREATE TABLE transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id),
        account_id uuid NOT NULL,
        type text NOT NULL CHECK (type IN ('charge', 'refund', 'credit')),
        amount numeric(12,2) NOT NULL CHECK (amount > 0),
        description text,
        occurred_at timestamptz NOT NULL,
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)
    )
    """,
    """
    CREATE TABLE audit_log (
        id bigserial PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations (id),
        actor_user_id uuid NOT NULL,
        action text NOT NULL,
        entity_type text NOT NULL,
        entity_id uuid NOT NULL,
        details jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX ix_users_org ON users (org_id)",
    "CREATE INDEX ix_accounts_org_status ON accounts (org_id, status)",
    "CREATE INDEX ix_accounts_org_name ON accounts (org_id, name)",
    "CREATE INDEX ix_transactions_org_occurred ON transactions (org_id, occurred_at DESC)",
    "CREATE INDEX ix_transactions_org_account_occurred"
    " ON transactions (org_id, account_id, occurred_at DESC)",
    "CREATE INDEX ix_audit_log_org_created ON audit_log (org_id, created_at DESC)",
]


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    for table in ("audit_log", "transactions", "accounts", "users", "organizations"):
        op.execute(f"DROP TABLE {table}")

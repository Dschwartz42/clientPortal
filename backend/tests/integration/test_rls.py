"""Database-level isolation: direct SQL as portal_app, no API involved."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import set_tenant

TENANT_TABLES = ["users", "accounts", "transactions", "audit_log"]
INSERT_ACCOUNT = text(
    "INSERT INTO accounts (org_id, name, status, tier, monthly_value, opened_at)"
    " VALUES (:org_id, 'Intruder', 'active', 'gold', 1, CURRENT_DATE)"
)


def test_tests_run_as_the_app_role(db):
    assert db.execute(text("SELECT current_user")).scalar() == "portal_app"


def test_select_returns_only_current_org(db, seeded):
    set_tenant(db, seeded.a.org.id)
    org_ids = db.execute(text("SELECT org_id FROM accounts")).scalars().all()
    assert len(org_ids) == 3
    assert set(org_ids) == {seeded.a.org.id}
    assert db.execute(text("SELECT count(*) FROM users")).scalar() == 2
    assert db.execute(text("SELECT count(*) FROM organizations")).scalar() == 1


def test_no_org_set_returns_zero_rows(db, seeded):
    # seeded leaves the setting as '' — exactly what a reused pooled connection looks like.
    for table in [*TENANT_TABLES, "organizations"]:
        assert db.execute(text(f"SELECT count(*) FROM {table}")).scalar() == 0


def test_insert_into_other_org_rejected(db, seeded):
    set_tenant(db, seeded.a.org.id)
    with pytest.raises(DBAPIError, match="row-level security"):
        with db.begin_nested():
            db.execute(INSERT_ACCOUNT, {"org_id": seeded.b.org.id})


def test_update_cannot_move_row_to_other_org(db, seeded):
    set_tenant(db, seeded.a.org.id)
    with pytest.raises(DBAPIError, match="row-level security"):
        with db.begin_nested():
            db.execute(
                text("UPDATE accounts SET org_id = :b WHERE id = :id"),
                {"b": seeded.b.org.id, "id": seeded.a.accounts[1].id},
            )


def test_update_and_delete_cannot_touch_other_org(db, seeded):
    set_tenant(db, seeded.a.org.id)
    target = {"id": seeded.b.accounts[1].id}
    updated = db.execute(text("UPDATE accounts SET name = 'pwned' WHERE id = :id"), target)
    deleted = db.execute(text("DELETE FROM accounts WHERE id = :id"), target)
    assert updated.rowcount == 0
    assert deleted.rowcount == 0


def test_transaction_cannot_reference_other_orgs_account(db, seeded):
    set_tenant(db, seeded.a.org.id)
    with pytest.raises(IntegrityError, match="foreign key"):
        with db.begin_nested():
            db.execute(
                text(
                    "INSERT INTO transactions (org_id, account_id, type, amount, occurred_at)"
                    " VALUES (:org_id, :account_id, 'charge', 10, now())"
                ),
                {"org_id": seeded.a.org.id, "account_id": seeded.b.accounts[0].id},
            )


def test_auth_find_user_works_without_tenant_context(db, seeded):
    assert db.execute(text("SELECT count(*) FROM users")).scalar() == 0
    row = db.execute(
        text("SELECT org_id, role FROM auth_find_user(CAST(:email AS citext))"),
        {"email": "ADMIN@orga.test"},
    ).one()
    assert row.org_id == seeded.a.org.id
    assert row.role == "admin"

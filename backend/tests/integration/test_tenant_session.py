"""Tests on the real engine and SessionLocal (no savepoint fixtures), writing no data."""

import uuid

from sqlalchemy import text

from app.db import SessionLocal, get_db, set_tenant

SETTING = text("SELECT current_setting('app.current_org_id', true)")


def test_tenant_survives_commit_within_the_same_session():
    org_id = uuid.uuid4()
    with SessionLocal() as session:
        set_tenant(session, org_id)
        session.commit()
        assert session.execute(SETTING).scalar() == str(org_id)


def test_tenant_does_not_leak_to_a_new_session():
    with SessionLocal() as session:
        set_tenant(session, uuid.uuid4())
        session.commit()
        session.execute(SETTING)
    with SessionLocal() as fresh:
        assert fresh.execute(SETTING).scalar() in ("", None)
        assert fresh.execute(text("SELECT count(*) FROM accounts")).scalar() == 0


def test_get_db_yields_a_working_session_and_closes_it():
    gen = get_db()
    session = next(gen)
    assert session.execute(text("SELECT 1")).scalar() == 1
    assert session.in_transaction()
    gen.close()
    assert not session.in_transaction()

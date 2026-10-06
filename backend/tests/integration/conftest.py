import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from alembic import command
from app.db import engine, get_db, set_tenant
from app.main import app
from app.models import Account, Organization, Transaction, User
from app.security import create_access_token, hash_password

BACKEND = Path(__file__).resolve().parents[2]
PASSWORD = "CorrectHorse1!"
PASSWORD_HASH = hash_password(PASSWORD)  # hashed once; argon2 is deliberately slow
CLEAR_TENANT = text("SELECT set_config('app.current_org_id', '', true)")


@dataclass
class OrgFixture:
    org: Organization
    admin: User
    member: User
    accounts: list[Account]


@dataclass
class Seeded:
    a: OrgFixture
    b: OrgFixture
    password: str


@pytest.fixture(scope="session", autouse=True)
def _migrate():
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(cfg, "head")


@pytest.fixture()
def conn():
    connection = engine.connect()
    transaction = connection.begin()
    try:
        yield connection
    finally:
        transaction.rollback()
        connection.close()


@pytest.fixture()
def db(conn):
    session = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    yield session
    session.close()


def _make_org(db: Session, slug: str, name: str) -> OrgFixture:
    org = Organization(id=uuid.uuid4(), name=name, slug=slug, plan="pro")
    set_tenant(db, org.id)  # fixtures insert as portal_app, so RLS applies to them too
    db.add(org)
    db.flush()
    admin = User(
        id=uuid.uuid4(),
        org_id=org.id,
        email=f"admin@{slug}.test",
        password_hash=PASSWORD_HASH,
        full_name=f"{name} Admin",
        role="admin",
    )
    member = User(
        id=uuid.uuid4(),
        org_id=org.id,
        email=f"member@{slug}.test",
        password_hash=PASSWORD_HASH,
        full_name=f"{name} Member",
        role="member",
    )
    db.add_all([admin, member])
    db.flush()
    today = date.today()
    accounts = [
        Account(
            id=uuid.uuid4(),
            org_id=org.id,
            name=f"{name} Alpha",
            status="active",
            tier="gold",
            monthly_value=Decimal("1000.00"),
            owner_user_id=admin.id,
            opened_at=today - timedelta(days=200),
        ),
        Account(
            id=uuid.uuid4(),
            org_id=org.id,
            name=f"{name} Beta",
            status="active",
            tier="silver",
            monthly_value=Decimal("500.00"),
            opened_at=today - timedelta(days=100),
        ),
        Account(
            id=uuid.uuid4(),
            org_id=org.id,
            name=f"{name} Gamma",
            status="closed",
            tier="bronze",
            monthly_value=Decimal("100.00"),
            opened_at=today - timedelta(days=300),
            closed_at=today - timedelta(days=20),
        ),
    ]
    db.add_all(accounts)
    db.flush()
    now = datetime.now(UTC)
    # Last 30 days: 1000 + 500 - 200 - 50 = 1250.00. Previous 30 days: 800 - 100 = 700.00.
    for type_, amount, days_ago in [
        ("charge", "1000.00", 5),
        ("charge", "500.00", 10),
        ("refund", "200.00", 12),
        ("credit", "50.00", 15),
        ("charge", "800.00", 40),
        ("refund", "100.00", 45),
    ]:
        db.add(
            Transaction(
                id=uuid.uuid4(),
                org_id=org.id,
                account_id=accounts[0].id,
                type=type_,
                amount=Decimal(amount),
                description=f"{type_} {days_ago}d ago",
                occurred_at=now - timedelta(days=days_ago),
            )
        )
    db.flush()
    return OrgFixture(org=org, admin=admin, member=member, accounts=accounts)


@pytest.fixture()
def seeded(db) -> Seeded:
    a = _make_org(db, "orga", "Org A")
    b = _make_org(db, "orgb", "Org B")
    db.execute(CLEAR_TENANT)
    return Seeded(a=a, b=b, password=PASSWORD)


@pytest.fixture()
def client(conn):
    def override_get_db():
        session = Session(
            bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False
        )
        # Every request starts with no tenant, as it would on a fresh pooled connection.
        session.execute(CLEAR_TENANT)
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def auth():
    def _headers(user: User) -> dict[str, str]:
        token = create_access_token(user.id, user.org_id, user.role)
        return {"Authorization": f"Bearer {token}"}

    return _headers

"""Deterministic demo data.

Run from backend/:  python -m scripts.seed --reset
Connects as portal_owner (MIGRATION_DATABASE_URL). --reset truncates every table first.
"""

import argparse
import random
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal

from faker import Faker
from sqlalchemy import create_engine, func, insert, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.config import settings
from app.db import set_tenant
from app.models import Account, AuditLog, Organization, Transaction, User
from app.security import hash_password
from app.services.analytics import net_revenue

DEMO_PASSWORD = "DemoPass123!"
MONTHS = 12
MONTH_DAYS = 30
TIERS = ["bronze", "silver", "gold"]
TIER_BASE = {"bronze": 200, "silver": 800, "gold": 2500}
TYPES = ["charge", "refund", "credit"]
DESCRIPTIONS = {
    "charge": "Monthly service charge",
    "refund": "Refund issued",
    "credit": "Goodwill credit",
}


@dataclass(frozen=True)
class OrgSpec:
    name: str
    slug: str
    plan: str
    accounts: int
    close_rate: float
    multiplier: Callable[[int], float]  # month index 0..11 -> charge size factor


ORGS = [
    # Steady growth: about 5% more revenue each month.
    OrgSpec("Acme Corp", "acme", "enterprise", 220, 0.05, lambda m: 1.05**m),
    # Declining from month 6, with many more closures.
    OrgSpec("Globex", "globex", "pro", 90, 0.30, lambda m: 1.0 if m < 5 else 0.85 ** (m - 4)),
    # Small and flat.
    OrgSpec("Initech", "initech", "free", 25, 0.05, lambda m: 1.0),
    # Big spike in month 9, then back to normal.
    OrgSpec("Umbrella Health", "umbrella", "pro", 70, 0.05, lambda m: 3.0 if m == 8 else 1.0),
]


def _uuid() -> uuid.UUID:
    return uuid.UUID(int=random.getrandbits(128), version=4)


def _money(value: float) -> Decimal:
    return Decimal(f"{value:.2f}")


def _noon(day: date) -> datetime:
    return datetime.combine(day, time(12), tzinfo=UTC)


def seed_org(
    session: Session, spec: OrgSpec, fake: Faker, password_hash: str, today: date
) -> uuid.UUID:
    org_id = _uuid()
    set_tenant(session, org_id)
    session.add(Organization(id=org_id, name=spec.name, slug=spec.slug, plan=spec.plan))
    session.flush()

    # (email local part, role, active): 1-2 admins, 2-4 members, one deactivated user.
    people = [("admin", "admin", True), ("member", "member", True)]
    people += [(f"admin{i + 2}", "admin", True) for i in range(random.randint(0, 1))]
    people += [(f"member{i + 2}", "member", True) for i in range(random.randint(1, 3))]
    people.append(("former", "member", False))
    users = [
        User(
            id=_uuid(),
            org_id=org_id,
            email=f"{local}@{spec.slug}.test",
            password_hash=password_hash,
            full_name=fake.name(),
            role=role,
            is_active=active,
        )
        for local, role, active in people
    ]
    session.add_all(users)
    session.flush()
    owners = [user.id for user in users if user.is_active]

    window_start = today - timedelta(days=MONTH_DAYS * MONTHS)
    accounts = []
    for _ in range(spec.accounts):
        tier = random.choices(TIERS, weights=[50, 35, 15])[0]
        if random.random() < 0.6:
            opened = window_start - timedelta(days=random.randint(1, 720))
        else:
            opened = window_start + timedelta(days=random.randint(0, 330))
        status, closed_at = "active", None
        roll = random.random()
        if roll < spec.close_rate:
            status = "closed"
            target = window_start + timedelta(days=random.randint(150, 350))
            closed_at = min(today, max(opened + timedelta(days=30), target))
        elif roll < spec.close_rate + 0.05:
            status = "paused"
        accounts.append(
            Account(
                id=_uuid(),
                org_id=org_id,
                name=fake.company(),
                status=status,
                tier=tier,
                monthly_value=_money(TIER_BASE[tier] * random.uniform(0.7, 1.3)),
                owner_user_id=random.choice(owners),
                opened_at=opened,
                closed_at=closed_at,
            )
        )
    session.add_all(accounts)
    session.flush()

    transactions = []
    for month in range(MONTHS):
        month_start = window_start + timedelta(days=MONTH_DAYS * month)
        month_end = month_start + timedelta(days=MONTH_DAYS)
        for account in accounts:
            first = max(month_start, account.opened_at)
            last = min(month_end, account.closed_at or month_end)
            if first >= last:
                continue
            for _ in range(random.choice([1, 1, 2])):
                type_ = random.choices(TYPES, weights=[90, 6, 4])[0]
                base = TIER_BASE[account.tier] * random.uniform(0.7, 1.3)
                if type_ == "charge":
                    amount = base * spec.multiplier(month)
                else:
                    amount = base * random.uniform(0.2, 0.6)
                offset = random.randint(0, (last - first).days * 86400 - 1)
                transactions.append(
                    {
                        "id": _uuid(),
                        "org_id": org_id,
                        "account_id": account.id,
                        "type": type_,
                        "amount": _money(amount),
                        "description": DESCRIPTIONS[type_],
                        "occurred_at": datetime.combine(first, time.min, tzinfo=UTC)
                        + timedelta(seconds=offset),
                    }
                )
    session.execute(insert(Transaction), transactions)

    admin = users[0]
    entries = []
    for account in random.sample(accounts, k=min(20, len(accounts))):
        entries.append(
            (
                "account.created",
                "account",
                account.id,
                max(account.opened_at, window_start),
                {"after": {"name": account.name, "tier": account.tier}},
            )
        )
    for account in [a for a in accounts if a.closed_at][:10]:
        entries.append(
            (
                "account.updated",
                "account",
                account.id,
                account.closed_at,
                {"before": {"status": "active"}, "after": {"status": "closed"}},
            )
        )
    for user in users[2:]:
        entries.append(
            (
                "user.invited",
                "user",
                user.id,
                window_start + timedelta(days=random.randint(0, 300)),
                {"after": {"email": user.email, "role": user.role}},
            )
        )
    session.add_all(
        AuditLog(
            org_id=org_id,
            actor_user_id=admin.id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
            created_at=_noon(day),
        )
        for action, entity_type, entity_id, day, details in entries
    )
    session.flush()
    return org_id


def print_summary(session: Session, org_ids: dict[str, uuid.UUID]) -> None:
    print(
        f"{'org':<10}{'users':>7}{'accounts':>10}{'transactions':>14}{'audit':>7}{'net revenue':>16}"
    )
    for slug, org_id in org_ids.items():
        set_tenant(session, org_id)
        counts = [
            session.scalar(select(func.count()).select_from(model).where(model.org_id == org_id))
            for model in (User, Account, Transaction, AuditLog)
        ]
        rows = session.execute(select(Transaction.type, Transaction.amount)).all()
        total = net_revenue((row.type, row.amount) for row in rows)
        print(f"{slug:<10}{counts[0]:>7}{counts[1]:>10}{counts[2]:>14}{counts[3]:>7}{total:>16}")
    print(f"\nDemo logins (password {DEMO_PASSWORD}, demo only):")
    for slug in org_ids:
        print(f"  admin@{slug}.test   member@{slug}.test")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed deterministic demo data.")
    parser.add_argument("--reset", action="store_true", help="truncate all tables first")
    args = parser.parse_args()

    Faker.seed(42)
    random.seed(42)
    fake = Faker()
    today = datetime.now(UTC).date()
    password_hash = hash_password(DEMO_PASSWORD)
    engine = create_engine(settings.migration_database_url or settings.database_url)

    with Session(engine) as session:
        if args.reset:
            session.execute(
                text(
                    "TRUNCATE audit_log, transactions, accounts, users, organizations"
                    " RESTART IDENTITY CASCADE"
                )
            )
        try:
            org_ids = {
                spec.slug: seed_org(session, spec, fake, password_hash, today) for spec in ORGS
            }
        except IntegrityError:
            session.rollback()
            print("Seed data already exists. Re-run with --reset to replace it.")
            sys.exit(1)
        print_summary(session, org_ids)
        session.commit()


if __name__ == "__main__":
    main()

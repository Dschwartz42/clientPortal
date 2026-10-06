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
from sqlalchemy.engine import URL, make_url
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


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}


def is_local_host(host: str | None) -> bool:
    """True for loopback hosts and for a unix socket (no host)."""
    return not host or host in LOCAL_HOSTS


def describe_target(url: URL) -> str:
    """One line naming the target. Never includes the password."""
    return f'Seeding database "{url.database}" on {url.host or "local socket"}:{url.port or 5432} as {url.username}'


def transacting_span(
    opened_at: date, closed_at: date | None, window_start: date, month: int, month_days: int
) -> tuple[date, date] | None:
    """The days of 30-day bucket `month` on which an account can transact, or None."""
    month_start = window_start + timedelta(days=month_days * month)
    month_end = month_start + timedelta(days=month_days)
    first = max(month_start, opened_at)
    last = min(month_end, closed_at or month_end)
    return (first, last) if first < last else None


def eligible_counts(
    pairs: list[tuple[date, date | None]], window_start: date, months: int, month_days: int
) -> list[int]:
    """Accounts that can transact in each bucket, given (opened_at, closed_at) pairs."""
    return [
        sum(
            transacting_span(opened, closed, window_start, month, month_days) is not None
            for opened, closed in pairs
        )
        for month in range(months)
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

    # Charges are divided by the realised eligible-account count so the multiplier is the
    # only growth. Counting draws no random numbers.
    eligible = eligible_counts(
        [(a.opened_at, a.closed_at) for a in accounts], window_start, MONTHS, MONTH_DAYS
    )
    transactions = []
    for month in range(MONTHS):
        scale = eligible[0] / eligible[month] if eligible[month] and eligible[0] else 1.0
        for account in accounts:
            span = transacting_span(
                account.opened_at, account.closed_at, window_start, month, MONTH_DAYS
            )
            if span is None:
                continue
            first, last = span
            for _ in range(random.choice([1, 1, 2])):
                type_ = random.choices(TYPES, weights=[90, 6, 4])[0]
                base = TIER_BASE[account.tier] * random.uniform(0.7, 1.3)
                if type_ == "charge":
                    amount = base * spec.multiplier(month) * scale
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


def summary_lines(session: Session, org_ids: dict[str, uuid.UUID]) -> list[str]:
    lines = [
        f"{'org':<10}{'users':>7}{'accounts':>10}{'transactions':>14}{'audit':>7}{'net revenue':>16}"
    ]
    for slug, org_id in org_ids.items():
        set_tenant(session, org_id)
        counts = [
            session.scalar(select(func.count()).select_from(model).where(model.org_id == org_id))
            for model in (User, Account, Transaction, AuditLog)
        ]
        rows = session.execute(select(Transaction.type, Transaction.amount)).all()
        total = net_revenue((row.type, row.amount) for row in rows)
        lines.append(
            f"{slug:<10}{counts[0]:>7}{counts[1]:>10}{counts[2]:>14}{counts[3]:>7}{total:>16}"
        )
    lines.append(f"\nDemo logins (password {DEMO_PASSWORD}, demo only):")
    lines += [f"  admin@{slug}.test   member@{slug}.test" for slug in org_ids]
    return lines


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed deterministic demo data.")
    parser.add_argument("--reset", action="store_true", help="truncate all tables first")
    parser.add_argument("--yes", action="store_true", help="allow a non-local database")
    args = parser.parse_args()

    if not settings.migration_database_url:
        print("MIGRATION_DATABASE_URL (the portal_owner URL) is required to seed.")
        sys.exit(2)
    url = make_url(settings.migration_database_url)
    print(describe_target(url))
    if not is_local_host(url.host) and not args.yes:
        print("This is not a local database. Re-run with --yes to seed it anyway.")
        sys.exit(2)

    Faker.seed(42)
    random.seed(42)
    fake = Faker()
    today = datetime.now(UTC).date()
    password_hash = hash_password(DEMO_PASSWORD)
    engine = create_engine(url)

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
            if args.reset:
                raise
            print("Seed data already exists. Re-run with --reset to replace it.")
            sys.exit(1)
        lines = summary_lines(session, org_ids)
        session.commit()
    print("\n".join(lines))


if __name__ == "__main__":
    main()

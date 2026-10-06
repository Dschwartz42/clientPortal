# Client Portal — Plan 3 of 5: Analytics, Users, Audit Log and Seed Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the API (analytics, user administration, audit log) and add a deterministic seed script that gives four tenants visibly different data.

**Architecture:** Same request model as Plan 1: `CurrentUser`/`AdminUser` dependencies scope the transaction to the tenant, routers also filter by `org_id`, and write routes commit explicitly. Analytics are SQL aggregates; time series use `generate_series` so empty periods come back as zeros. Business rules that can be tested without a database (last-admin rule, revenue maths) live in `app/services/` as pure functions.

**Tech Stack:** FastAPI, SQLAlchemy 2.0, PostgreSQL 16, pytest, Faker.

**Spec:** `client-portal-spec.md` — sections 2, 6, 8, 9.1.

**Sequence:** Requires Plans 1 and 2. Tasks 1–3 land as one PR, Task 4 (seed) as a second PR.

## Global Constraints

- Errors: `{ "error": { "code", "message" } }`; cross-tenant access is 404; role failures are 403; rule violations are 409; validation is 422.
- Lists: `{ items, total, page, page_size }`, `page_size` capped at 100.
- Money is a string in JSON, always two decimal places.
- Net revenue = sum(charges) − sum(refunds) − sum(credits).
- An organization must always have at least one active admin. An admin cannot deactivate themselves.
- Seed: `Faker.seed(42)` and `random.seed(42)`; runs as `portal_owner`; demo password `DemoPass123!`; logins `admin@<slug>.test` and `member@<slug>.test`.
- `ruff check .`, `ruff format --check .` and `pytest --cov=app --cov-fail-under=80` pass before every commit.

## Review Focus

1. No revenue in the previous 30 days → `net_revenue_change_pct` is `null`, not a division error (Task 1).
2. A brand-new organization with no accounts or transactions → summary is all zeros, time series is all zeros, top accounts is `[]` (Task 1).
3. Time series with `from` after `to`, or a range of decades → 422, not a huge or empty query (Task 1).
4. Inviting an email that already exists in *another* tenant (invisible under RLS, but globally unique) → 409, not a 500 from the unique constraint (Task 2).
5. An admin demoting themselves while another active admin exists → allowed; when they are the last → 409 (Task 2).

---

### Task 1: Analytics endpoints

**Files:**
- Create: `backend/app/schemas/analytics.py`, `backend/app/routers/analytics.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/integration/test_analytics.py`

**Interfaces:**
- Consumes: `app.services.analytics.{money, pct_change, signed_amount, net_revenue_between}`, `CurrentUser`, `Db`, `ApiError`; fixture `seeded` (Org A: 2 active accounts worth 1500.00/month; Alpha net 1250.00 in the last 30 days, 700.00 in the 30 before).
- Produces:
  - `GET /api/analytics/summary` → `{active_accounts, total_monthly_value, net_revenue_30d, net_revenue_prev_30d, net_revenue_change_pct}`
  - `GET /api/analytics/timeseries?metric=net_revenue|new_accounts&interval=week|month&from=&to=` → `[{period: "YYYY-MM-DD", value}]`. `value` is a money string for `net_revenue` and an integer for `new_accounts`. Defaults: `to` = today, `from` = `to` − 365 days. Whole periods are returned (the range is widened to period boundaries).
  - `GET /api/analytics/top-accounts?limit=5&days=90` → `[{account_id, name, tier, net_revenue}]`

- [ ] **Step 1: Branch**

```bash
git switch main && git pull && git switch -c feat/api-analytics-users-audit
```

- [ ] **Step 2: Write the failing tests**

`backend/tests/integration/test_analytics.py`:

```python
import uuid
from datetime import date, timedelta
from decimal import Decimal

from app.db import set_tenant
from app.models import Organization, User


def _empty_org_admin(db, seeded) -> User:
    org = Organization(id=uuid.uuid4(), name="Empty Org", slug="empty", plan="free")
    set_tenant(db, org.id)
    db.add(org)
    db.flush()
    admin = User(
        id=uuid.uuid4(), org_id=org.id, email="admin@empty.test",
        password_hash=seeded.a.admin.password_hash, full_name="Empty Admin", role="admin",
    )
    db.add(admin)
    db.flush()
    return admin


def test_summary_matches_fixture_numbers(client, seeded, auth):
    r = client.get("/api/analytics/summary", headers=auth(seeded.a.member))
    assert r.status_code == 200
    assert r.json() == {
        "active_accounts": 2,
        "total_monthly_value": "1500.00",
        "net_revenue_30d": "1250.00",
        "net_revenue_prev_30d": "700.00",
        "net_revenue_change_pct": 78.57,
    }


def test_summary_for_org_with_no_data_is_zeros(client, db, seeded, auth):
    admin = _empty_org_admin(db, seeded)
    r = client.get("/api/analytics/summary", headers=auth(admin))
    assert r.json() == {
        "active_accounts": 0,
        "total_monthly_value": "0.00",
        "net_revenue_30d": "0.00",
        "net_revenue_prev_30d": "0.00",
        "net_revenue_change_pct": None,
    }


def test_summary_requires_token(client, seeded):
    assert client.get("/api/analytics/summary").status_code == 401


def test_monthly_revenue_series_is_zero_filled_and_complete(client, seeded, auth):
    r = client.get("/api/analytics/timeseries?metric=net_revenue", headers=auth(seeded.a.member))
    assert r.status_code == 200
    points = r.json()
    periods = [date.fromisoformat(p["period"]) for p in points]
    assert len(points) in (12, 13)
    assert all(p.day == 1 for p in periods)
    assert periods == sorted(set(periods))
    assert "0.00" in [p["value"] for p in points]
    assert sum(Decimal(p["value"]) for p in points) == Decimal("1950.00")


def test_weekly_series_steps_by_seven_days(client, seeded, auth):
    start = date.today() - timedelta(days=28)
    r = client.get(
        "/api/analytics/timeseries",
        params={"metric": "net_revenue", "interval": "week", "from": str(start)},
        headers=auth(seeded.a.member),
    )
    periods = [date.fromisoformat(p["period"]) for p in r.json()]
    assert len(periods) == 5
    assert all(p.weekday() == 0 for p in periods)
    assert all((b - a).days == 7 for a, b in zip(periods, periods[1:], strict=False))


def test_new_accounts_series_counts_integers(client, seeded, auth):
    r = client.get("/api/analytics/timeseries?metric=new_accounts", headers=auth(seeded.a.member))
    values = [p["value"] for p in r.json()]
    assert all(isinstance(v, int) for v in values)
    assert sum(values) == 3


def test_series_for_org_with_no_data_is_all_zero(client, db, seeded, auth):
    admin = _empty_org_admin(db, seeded)
    r = client.get("/api/analytics/timeseries?metric=net_revenue", headers=auth(admin))
    assert {p["value"] for p in r.json()} == {"0.00"}


def test_series_rejects_bad_parameters(client, seeded, auth):
    headers = auth(seeded.a.member)
    today = date.today()
    cases = [
        {"metric": "profit"},
        {"metric": "net_revenue", "interval": "day"},
        {"metric": "net_revenue", "from": str(today), "to": str(today - timedelta(days=1))},
        {"metric": "net_revenue", "from": "1900-01-01"},
        {},
    ]
    for params in cases:
        r = client.get("/api/analytics/timeseries", params=params, headers=headers)
        assert r.status_code == 422, params


def test_top_accounts_ranked_by_net_revenue(client, seeded, auth):
    r = client.get("/api/analytics/top-accounts", headers=auth(seeded.a.member))
    assert r.status_code == 200
    assert r.json() == [
        {
            "account_id": str(seeded.a.accounts[0].id),
            "name": "Org A Alpha",
            "tier": "gold",
            "net_revenue": "1950.00",
        }
    ]


def test_top_accounts_respects_days_window(client, seeded, auth):
    r = client.get("/api/analytics/top-accounts?days=30", headers=auth(seeded.a.member))
    assert r.json()[0]["net_revenue"] == "1250.00"


def test_top_accounts_empty_for_org_with_no_data(client, db, seeded, auth):
    admin = _empty_org_admin(db, seeded)
    assert client.get("/api/analytics/top-accounts", headers=auth(admin)).json() == []


def test_top_accounts_limit_bounds(client, seeded, auth):
    r = client.get("/api/analytics/top-accounts?limit=0", headers=auth(seeded.a.member))
    assert r.status_code == 422
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/integration/test_analytics.py -v`
Expected: FAIL — 404 on every analytics route.

- [ ] **Step 4: Implement**

`backend/app/schemas/analytics.py`:

```python
import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class SummaryOut(BaseModel):
    active_accounts: int
    total_monthly_value: Decimal
    net_revenue_30d: Decimal
    net_revenue_prev_30d: Decimal
    net_revenue_change_pct: float | None


class TimeseriesPoint(BaseModel):
    period: date
    value: Decimal | int


class TopAccountOut(BaseModel):
    account_id: uuid.UUID
    name: str
    tier: str
    net_revenue: Decimal
```

`backend/app/routers/analytics.py`:

```python
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from sqlalchemy import and_, func, select, text

from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.models import Account, Transaction
from app.schemas.analytics import SummaryOut, TimeseriesPoint, TopAccountOut
from app.services.analytics import money, net_revenue_between, pct_change, signed_amount

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

MAX_RANGE_DAYS = 366 * 5
STEP = {"week": "1 week", "month": "1 month"}

# generate_series produces every period in the range, so periods with no rows
# still appear (LEFT JOIN + COALESCE/COUNT gives them a zero).
_PERIODS = """
    generate_series(
        date_trunc(:unit, CAST(:start AS timestamp)),
        date_trunc(:unit, CAST(:end AS timestamp)),
        CAST(:step AS interval)
    ) AS gs(period)
"""
TIMESERIES_SQL = {
    "net_revenue": text(
        f"""
        SELECT CAST(gs.period AS date) AS period,
               COALESCE(SUM(CASE WHEN t.type = 'charge' THEN t.amount ELSE -t.amount END), 0)
                   AS value
        FROM {_PERIODS}
        LEFT JOIN transactions t
          ON t.org_id = :org_id
         AND date_trunc(:unit, t.occurred_at AT TIME ZONE 'UTC') = gs.period
        GROUP BY gs.period
        ORDER BY gs.period
        """
    ),
    "new_accounts": text(
        f"""
        SELECT CAST(gs.period AS date) AS period, COUNT(a.id) AS value
        FROM {_PERIODS}
        LEFT JOIN accounts a
          ON a.org_id = :org_id
         AND date_trunc(:unit, CAST(a.opened_at AS timestamp)) = gs.period
        GROUP BY gs.period
        ORDER BY gs.period
        """
    ),
}


@router.get("/summary", response_model=SummaryOut)
def summary(user: CurrentUser, db: Db):
    active_accounts, total_value = db.execute(
        select(func.count(Account.id), func.sum(Account.monthly_value)).where(
            Account.org_id == user.org_id, Account.status == "active"
        )
    ).one()
    now = datetime.now(UTC)
    current = net_revenue_between(db, user.org_id, now - timedelta(days=30), now)
    previous = net_revenue_between(
        db, user.org_id, now - timedelta(days=60), now - timedelta(days=30)
    )
    return SummaryOut(
        active_accounts=active_accounts,
        total_monthly_value=money(total_value),
        net_revenue_30d=current,
        net_revenue_prev_30d=previous,
        net_revenue_change_pct=pct_change(current, previous),
    )


@router.get("/timeseries", response_model=list[TimeseriesPoint])
def timeseries(
    user: CurrentUser,
    db: Db,
    metric: Literal["net_revenue", "new_accounts"],
    interval: Literal["week", "month"] = "month",
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
):
    end = to or datetime.now(UTC).date()
    start = from_ or end - timedelta(days=365)
    if start > end:
        raise ApiError(422, "validation_error", "from: must not be after to")
    if (end - start).days > MAX_RANGE_DAYS:
        raise ApiError(422, "validation_error", "from: range must be 5 years or less")

    rows = db.execute(
        TIMESERIES_SQL[metric],
        {
            "unit": interval,
            "step": STEP[interval],
            "start": start,
            "end": end,
            "org_id": user.org_id,
        },
    ).all()
    convert = money if metric == "net_revenue" else int
    return [TimeseriesPoint(period=row.period, value=convert(row.value)) for row in rows]


@router.get("/top-accounts", response_model=list[TopAccountOut])
def top_accounts(
    user: CurrentUser,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=50)] = 5,
    days: Annotated[int, Query(ge=1, le=3650)] = 90,
):
    since = datetime.now(UTC) - timedelta(days=days)
    net = func.sum(signed_amount()).label("net_revenue")
    rows = db.execute(
        select(Account.id, Account.name, Account.tier, net)
        .join(
            Transaction,
            and_(Transaction.org_id == Account.org_id, Transaction.account_id == Account.id),
        )
        .where(Account.org_id == user.org_id, Transaction.occurred_at >= since)
        .group_by(Account.id, Account.name, Account.tier)
        .order_by(net.desc(), Account.name)
        .limit(limit)
    ).all()
    return [
        TopAccountOut(
            account_id=row.id, name=row.name, tier=row.tier, net_revenue=money(row.net_revenue)
        )
        for row in rows
    ]
```

In `backend/app/main.py`: add `analytics` to the `app.routers` import and `app.include_router(analytics.router)`.

- [ ] **Step 5: Run, lint, commit**

Run: `pytest -v && ruff check . && ruff format --check .`
Expected: all pass (12 new).

```bash
git add -A && git commit -m "feat: analytics summary, zero-filled time series, top accounts"
```

---

### Task 2: User administration

**Files:**
- Create: `backend/app/services/users.py`, `backend/app/schemas/users.py`, `backend/app/routers/users.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/unit/test_user_rules.py`, `backend/tests/integration/test_users.py`

**Interfaces:**
- Consumes: `AdminUser`, `Db`, `PageDep`, `Paginated`, `ApiError`, `app.services.audit.record`, `app.security.hash_password`.
- Produces:
  - `app.services.users.check_user_update(*, actor_id, target_id, target_role, target_is_active, new_role, new_is_active, other_active_admins: int) -> tuple[str, str] | None` — returns `(code, message)` for a violated rule, else `None`.
  - `GET /api/users` (paginated `UserOut`), `POST /api/users` → 201 `UserOut` + `temporary_password`, `PATCH /api/users/{id}` → `UserOut`.
  - Audit actions: `user.invited`, `user.role_changed`, `user.deactivated`, `user.reactivated`.

- [ ] **Step 1: Write the failing unit tests**

`backend/tests/unit/test_user_rules.py`:

```python
import uuid

from app.services.users import check_user_update

ME, OTHER = uuid.uuid4(), uuid.uuid4()


def _check(**overrides):
    args = {
        "actor_id": ME,
        "target_id": OTHER,
        "target_role": "admin",
        "target_is_active": True,
        "new_role": "admin",
        "new_is_active": True,
        "other_active_admins": 0,
    }
    return check_user_update(**{**args, **overrides})


def test_demoting_the_last_admin_is_rejected():
    assert _check(new_role="member")[0] == "last_admin"


def test_deactivating_the_last_admin_is_rejected():
    assert _check(new_is_active=False)[0] == "last_admin"


def test_demoting_an_admin_is_fine_when_another_remains():
    assert _check(new_role="member", other_active_admins=1) is None


def test_changing_a_member_never_trips_the_last_admin_rule():
    assert _check(target_role="member", new_role="member", new_is_active=False) is None


def test_inactive_admin_does_not_count_as_the_last_admin():
    assert _check(target_is_active=False, new_role="member", new_is_active=False) is None


def test_admin_cannot_deactivate_themselves_even_with_other_admins():
    result = _check(target_id=ME, new_is_active=False, other_active_admins=3)
    assert result[0] == "cannot_deactivate_self"


def test_admin_can_demote_themselves_when_another_admin_remains():
    assert _check(target_id=ME, new_role="member", other_active_admins=1) is None


def test_no_change_is_fine():
    assert _check() is None
```

- [ ] **Step 2: Write the failing integration tests**

`backend/tests/integration/test_users.py`:

```python
from sqlalchemy import text

from app.db import set_tenant

INVITE = {"email": "new.person@orga.test", "full_name": "New Person", "role": "member"}


def _patch(client, headers, user, body):
    return client.patch(f"/api/users/{user.id}", json=body, headers=headers)


def test_member_cannot_list_users(client, seeded, auth):
    r = client.get("/api/users", headers=auth(seeded.a.member))
    assert r.status_code == 403


def test_admin_lists_only_own_org_users(client, seeded, auth):
    r = client.get("/api/users", headers=auth(seeded.a.admin))
    assert r.status_code == 200
    assert r.json()["total"] == 2
    assert {u["email"] for u in r.json()["items"]} == {"admin@orga.test", "member@orga.test"}
    assert "password_hash" not in r.json()["items"][0]


def test_invite_returns_temporary_password_that_works(client, db, seeded, auth):
    r = client.post("/api/users", json=INVITE, headers=auth(seeded.a.admin))
    assert r.status_code == 201
    body = r.json()
    assert body["email"] == "new.person@orga.test" and body["is_active"] is True
    assert len(body["temporary_password"]) >= 12

    login = client.post(
        "/api/auth/login",
        json={"email": INVITE["email"], "password": body["temporary_password"]},
    )
    assert login.status_code == 200
    assert login.json()["user"]["org_name"] == "Org A"

    set_tenant(db, seeded.a.org.id)
    action = db.execute(
        text("SELECT action FROM audit_log WHERE entity_id = :id"), {"id": body["id"]}
    ).scalar_one()
    assert action == "user.invited"


def test_invite_duplicate_email_is_409(client, seeded, auth):
    headers = auth(seeded.a.admin)
    for email in ["member@orga.test", "MEMBER@ORGA.TEST", "admin@orgb.test"]:
        r = client.post("/api/users", json={**INVITE, "email": email}, headers=headers)
        assert r.status_code == 409, email
        assert r.json()["error"]["code"] == "email_taken"
    # The failed inserts must not have broken the request's transaction or tenant scope.
    assert client.get("/api/users", headers=headers).json()["total"] == 2


def test_invite_rejects_malformed_email_and_blank_name(client, seeded, auth):
    headers = auth(seeded.a.admin)
    bad_email = {**INVITE, "email": "not-an-email"}
    blank_name = {**INVITE, "full_name": "  "}
    assert client.post("/api/users", json=bad_email, headers=headers).status_code == 422
    assert client.post("/api/users", json=blank_name, headers=headers).status_code == 422


def test_member_cannot_invite(client, seeded, auth):
    r = client.post("/api/users", json=INVITE, headers=auth(seeded.a.member))
    assert r.status_code == 403


def test_promote_member_and_audit(client, db, seeded, auth):
    r = _patch(client, auth(seeded.a.admin), seeded.a.member, {"role": "admin"})
    assert r.status_code == 200
    assert r.json()["role"] == "admin"
    set_tenant(db, seeded.a.org.id)
    details = db.execute(
        text("SELECT details FROM audit_log WHERE action = 'user.role_changed'")
    ).scalar_one()
    assert details == {"before": {"role": "member"}, "after": {"role": "admin"}}


def test_demoting_the_last_admin_is_409(client, seeded, auth):
    r = _patch(client, auth(seeded.a.admin), seeded.a.admin, {"role": "member"})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "last_admin"


def test_admin_can_demote_self_once_another_admin_exists(client, seeded, auth):
    headers = auth(seeded.a.admin)
    _patch(client, headers, seeded.a.member, {"role": "admin"})
    r = _patch(client, headers, seeded.a.admin, {"role": "member"})
    assert r.status_code == 200
    # Role is read from the database on every request, so the old token is now a member's.
    assert client.get("/api/users", headers=headers).status_code == 403


def test_admin_cannot_deactivate_self(client, seeded, auth):
    r = _patch(client, auth(seeded.a.admin), seeded.a.admin, {"is_active": False})
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "cannot_deactivate_self"


def test_deactivated_users_token_stops_working_and_reactivation_restores_it(
    client, seeded, auth
):
    admin, member = auth(seeded.a.admin), auth(seeded.a.member)
    assert client.get("/api/accounts", headers=member).status_code == 200
    assert _patch(client, admin, seeded.a.member, {"is_active": False}).status_code == 200
    assert client.get("/api/accounts", headers=member).status_code == 401
    assert _patch(client, admin, seeded.a.member, {"is_active": True}).status_code == 200
    assert client.get("/api/accounts", headers=member).status_code == 200


def test_patch_other_orgs_user_is_404_and_unchanged(client, db, seeded, auth):
    r = _patch(client, auth(seeded.a.admin), seeded.b.member, {"role": "admin"})
    assert r.status_code == 404
    set_tenant(db, seeded.b.org.id)
    role = db.execute(
        text("SELECT role FROM users WHERE id = :id"), {"id": seeded.b.member.id}
    ).scalar_one()
    assert role == "member"


def test_patch_rejects_empty_and_null_bodies(client, seeded, auth):
    headers = auth(seeded.a.admin)
    assert _patch(client, headers, seeded.a.member, {}).status_code == 422
    assert _patch(client, headers, seeded.a.member, {"role": None}).status_code == 422
    assert _patch(client, headers, seeded.a.member, {"role": "owner"}).status_code == 422
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/unit/test_user_rules.py tests/integration/test_users.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.users'` and 404s.

- [ ] **Step 4: Implement the rule and schemas**

`backend/app/services/users.py`:

```python
import uuid


def check_user_update(
    *,
    actor_id: uuid.UUID,
    target_id: uuid.UUID,
    target_role: str,
    target_is_active: bool,
    new_role: str,
    new_is_active: bool,
    other_active_admins: int,
) -> tuple[str, str] | None:
    """Return (code, message) if the change breaks an organization rule, else None."""
    if actor_id == target_id and target_is_active and not new_is_active:
        return ("cannot_deactivate_self", "You cannot deactivate your own account")
    was_active_admin = target_role == "admin" and target_is_active
    stays_active_admin = new_role == "admin" and new_is_active
    if was_active_admin and not stays_active_admin and other_active_admins == 0:
        return ("last_admin", "An organization must have at least one active admin")
    return None
```

`backend/app/schemas/users.py`:

```python
import uuid
from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, StringConstraints, model_validator

Role = Literal["admin", "member"]
# Deliberately loose: demo tenants use the reserved .test domain, which strict
# validators such as pydantic's EmailStr reject.
Email = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$"
    ),
]
FullName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    role: Role
    is_active: bool
    last_login_at: datetime | None
    created_at: datetime


class UserInvite(BaseModel):
    email: Email
    full_name: FullName
    role: Role = "member"


class InvitedUserOut(UserOut):
    temporary_password: str


class UserUpdate(BaseModel):
    role: Role | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _at_least_one_real_value(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("provide role or is_active")
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self
```

- [ ] **Step 5: Implement the router**

`backend/app/routers/users.py`:

```python
import secrets
import uuid

from fastapi import APIRouter
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.deps import AdminUser, Db
from app.errors import ApiError
from app.models import User
from app.pagination import PageDep
from app.schemas.common import Paginated
from app.schemas.users import InvitedUserOut, UserInvite, UserOut, UserUpdate
from app.security import hash_password
from app.services import audit
from app.services.users import check_user_update

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=Paginated[UserOut])
def list_users(admin: AdminUser, db: Db, page: PageDep):
    conditions = [User.org_id == admin.org_id]
    total = db.scalar(select(func.count()).select_from(User).where(*conditions))
    rows = db.scalars(
        select(User)
        .where(*conditions)
        .order_by(User.full_name, User.id)
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    return {"items": rows, "total": total, "page": page.page, "page_size": page.page_size}


@router.post("", response_model=InvitedUserOut, status_code=201)
def invite_user(body: UserInvite, admin: AdminUser, db: Db):
    temporary_password = secrets.token_urlsafe(12)
    user = User(
        id=uuid.uuid4(),
        org_id=admin.org_id,
        email=body.email,
        password_hash=hash_password(temporary_password),
        full_name=body.full_name,
        role=body.role,
        is_active=True,
    )
    # Emails are unique across all tenants, and RLS hides other tenants' users, so a
    # pre-check cannot see every conflict. Let the constraint decide, inside a savepoint
    # so a conflict does not abort the request's transaction.
    try:
        with db.begin_nested():
            db.add(user)
            db.flush()
    except IntegrityError:
        raise ApiError(409, "email_taken", "A user with this email already exists") from None

    db.refresh(user)
    audit.record(
        db, admin, "user.invited", "user", user.id, {"after": {"email": user.email, "role": user.role}}
    )
    out = InvitedUserOut(
        **UserOut.model_validate(user).model_dump(), temporary_password=temporary_password
    )
    db.commit()
    return out


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserUpdate, admin: AdminUser, db: Db):
    target = db.scalar(select(User).where(User.id == user_id, User.org_id == admin.org_id))
    if target is None:
        raise ApiError(404, "not_found", "User not found")

    changes = body.model_dump(exclude_unset=True)
    new_role = changes.get("role", target.role)
    new_is_active = changes.get("is_active", target.is_active)

    # Lock the org's active admins so two concurrent demotions cannot both pass the check.
    admin_ids = db.scalars(
        select(User.id)
        .where(User.org_id == admin.org_id, User.role == "admin", User.is_active.is_(True))
        .with_for_update()
    ).all()
    violation = check_user_update(
        actor_id=admin.id,
        target_id=target.id,
        target_role=target.role,
        target_is_active=target.is_active,
        new_role=new_role,
        new_is_active=new_is_active,
        other_active_admins=len([i for i in admin_ids if i != target.id]),
    )
    if violation:
        raise ApiError(409, *violation)

    if new_role != target.role:
        audit.record(
            db, admin, "user.role_changed", "user", target.id,
            {"before": {"role": target.role}, "after": {"role": new_role}},
        )
        target.role = new_role
    if new_is_active != target.is_active:
        action = "user.reactivated" if new_is_active else "user.deactivated"
        audit.record(db, admin, action, "user", target.id, {"after": {"is_active": new_is_active}})
        target.is_active = new_is_active

    db.flush()
    out = UserOut.model_validate(target)
    db.commit()
    return out
```

In `backend/app/main.py`: add `users` to the `app.routers` import and `app.include_router(users.router)`.

- [ ] **Step 6: Run, lint, commit**

Run: `pytest -v && ruff check . && ruff format --check .`
Expected: all pass (8 unit + 13 integration new).

```bash
git add -A && git commit -m "feat: user invite, role and activation management with last-admin rule"
```

---

### Task 3: Audit log endpoint, then PR

**Files:**
- Create: `backend/app/schemas/audit.py`, `backend/app/routers/audit.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/integration/test_audit.py`

**Interfaces:**
- Consumes: `AdminUser`, `Db`, `PageDep`, `Paginated`.
- Produces: `GET /api/audit-log?action=&page=&page_size=` → paginated `{id, actor_user_id, actor_name, action, entity_type, entity_id, details, created_at}`, newest first.

- [ ] **Step 1: Write the failing tests**

`backend/tests/integration/test_audit.py`:

```python
NEW_ACCOUNT = {"name": "Audited Client", "tier": "gold", "monthly_value": "10.00"}


def _make_entries(client, headers):
    created = client.post("/api/accounts", json=NEW_ACCOUNT, headers=headers).json()
    client.patch(f"/api/accounts/{created['id']}", json={"tier": "silver"}, headers=headers)
    return created


def test_member_cannot_read_audit_log(client, seeded, auth):
    assert client.get("/api/audit-log", headers=auth(seeded.a.member)).status_code == 403


def test_admin_sees_entries_newest_first_with_actor_name(client, seeded, auth):
    headers = auth(seeded.a.admin)
    created = _make_entries(client, headers)
    r = client.get("/api/audit-log", headers=headers)
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 2
    assert [e["action"] for e in body["items"]] == ["account.updated", "account.created"]
    newest = body["items"][0]
    assert newest["actor_name"] == "Org A Admin"
    assert newest["entity_type"] == "account"
    assert newest["entity_id"] == created["id"]
    assert newest["details"] == {"before": {"tier": "gold"}, "after": {"tier": "silver"}}


def test_filter_by_action(client, seeded, auth):
    headers = auth(seeded.a.admin)
    _make_entries(client, headers)
    r = client.get("/api/audit-log?action=account.created", headers=headers)
    assert [e["action"] for e in r.json()["items"]] == ["account.created"]


def test_other_orgs_entries_are_invisible(client, seeded, auth):
    _make_entries(client, auth(seeded.a.admin))
    r = client.get("/api/audit-log", headers=auth(seeded.b.admin))
    assert r.json() == {"items": [], "total": 0, "page": 1, "page_size": 25}


def test_pagination(client, seeded, auth):
    headers = auth(seeded.a.admin)
    _make_entries(client, headers)
    r = client.get("/api/audit-log?page_size=1&page=2", headers=headers)
    assert r.json()["total"] == 2
    assert [e["action"] for e in r.json()["items"]] == ["account.created"]
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/integration/test_audit.py -v`
Expected: FAIL — 404 on `/api/audit-log`.

- [ ] **Step 3: Implement**

`backend/app/schemas/audit.py`:

```python
import uuid
from datetime import datetime

from pydantic import BaseModel


class AuditEntryOut(BaseModel):
    id: int
    actor_user_id: uuid.UUID
    actor_name: str | None
    action: str
    entity_type: str
    entity_id: uuid.UUID
    details: dict
    created_at: datetime
```

`backend/app/routers/audit.py`:

```python
from fastapi import APIRouter
from sqlalchemy import and_, func, select

from app.deps import AdminUser, Db
from app.models import AuditLog, User
from app.pagination import PageDep
from app.schemas.audit import AuditEntryOut
from app.schemas.common import Paginated

router = APIRouter(prefix="/api/audit-log", tags=["audit"])


@router.get("", response_model=Paginated[AuditEntryOut])
def list_audit_log(admin: AdminUser, db: Db, page: PageDep, action: str | None = None):
    conditions = [AuditLog.org_id == admin.org_id]
    if action:
        conditions.append(AuditLog.action == action)

    total = db.scalar(select(func.count()).select_from(AuditLog).where(*conditions))
    rows = db.execute(
        select(AuditLog, User.full_name)
        .outerjoin(
            User, and_(User.org_id == AuditLog.org_id, User.id == AuditLog.actor_user_id)
        )
        .where(*conditions)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    items = [
        AuditEntryOut(
            id=entry.id, actor_user_id=entry.actor_user_id, actor_name=actor_name,
            action=entry.action, entity_type=entry.entity_type, entity_id=entry.entity_id,
            details=entry.details, created_at=entry.created_at,
        )
        for entry, actor_name in rows
    ]
    return {"items": items, "total": total, "page": page.page, "page_size": page.page_size}
```

In `backend/app/main.py`: add `audit` to the `app.routers` import and `app.include_router(audit.router)`.

- [ ] **Step 4: Full verification**

Run: `pytest --cov=app --cov-fail-under=80 && ruff check . && ruff format --check .`
Expected: all pass, coverage ≥ 80%.

- [ ] **Step 5: Commit and open the PR**

```bash
git add -A && git commit -m "feat: audit log endpoint"
git push -u origin feat/api-analytics-users-audit
gh pr create --title "feat: analytics, user administration and audit log" --body "Completes the API in spec section 6. Adds unit tests for the last-admin rule and integration tests for analytics numbers, invite flow and audit visibility."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch main && git pull
```

Expected: `backend` check passes before the merge.

---

### Task 4: Seed script

**Files:**
- Create: `backend/scripts/seed.py`

**Interfaces:**
- Consumes: `app.config.settings.migration_database_url`, `app.db.set_tenant`, models, `app.security.hash_password`, `app.services.analytics.net_revenue`.
- Produces: `python -m scripts.seed --reset` — four orgs (`acme` 220 accounts, `globex` 90, `initech` 25, `umbrella` 70), 12 thirty-day months of transactions ending today, demo logins, audit entries, printed summary.

The seed connects as `portal_owner`. Four of the five tables have `FORCE ROW LEVEL SECURITY`, so even the owner must set the tenant before inserting each org's rows. That is why the script calls `set_tenant` per org.

- [ ] **Step 1: Branch**

```bash
git switch -c feat/seed-data
```

- [ ] **Step 2: Write the script**

`backend/scripts/seed.py`:

```python
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
            id=_uuid(), org_id=org_id, email=f"{local}@{spec.slug}.test",
            password_hash=password_hash, full_name=fake.name(), role=role, is_active=active,
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
                id=_uuid(), org_id=org_id, name=fake.company(), status=status, tier=tier,
                monthly_value=_money(TIER_BASE[tier] * random.uniform(0.7, 1.3)),
                owner_user_id=random.choice(owners), opened_at=opened, closed_at=closed_at,
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
            ("account.created", "account", account.id, max(account.opened_at, window_start),
             {"after": {"name": account.name, "tier": account.tier}})
        )
    for account in [a for a in accounts if a.closed_at][:10]:
        entries.append(
            ("account.updated", "account", account.id, account.closed_at,
             {"before": {"status": "active"}, "after": {"status": "closed"}})
        )
    for user in users[2:]:
        entries.append(
            ("user.invited", "user", user.id, window_start + timedelta(days=random.randint(0, 300)),
             {"after": {"email": user.email, "role": user.role}})
        )
    session.add_all(
        AuditLog(
            org_id=org_id, actor_user_id=admin.id, action=action, entity_type=entity_type,
            entity_id=entity_id, details=details, created_at=_noon(day),
        )
        for action, entity_type, entity_id, day, details in entries
    )
    session.flush()
    return org_id


def print_summary(session: Session, org_ids: dict[str, uuid.UUID]) -> None:
    print(f"{'org':<10}{'users':>7}{'accounts':>10}{'transactions':>14}{'audit':>7}{'net revenue':>16}")
    for slug, org_id in org_ids.items():
        set_tenant(session, org_id)
        counts = [
            session.scalar(select(func.count()).select_from(model))
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
```

- [ ] **Step 3: Run it twice and compare**

```bash
cd backend && alembic upgrade head
python -m scripts.seed --reset | tee /tmp/seed1.txt
python -m scripts.seed --reset | diff - /tmp/seed1.txt && echo IDENTICAL
```

Expected: a four-row summary with 220 / 90 / 25 / 70 accounts, the eight demo logins, and `IDENTICAL` (same day, same data).

Run: `python -m scripts.seed`
Expected: `Seed data already exists. Re-run with --reset to replace it.` and exit code 1.

- [ ] **Step 4: Verify isolation and the stories through the API**

Run: `docker compose exec db psql -U portal_app -d portal -c "SELECT count(*) FROM accounts"`
Expected: `0` — the app role with no tenant set sees nothing, even with ~400 rows in the table.

```bash
uvicorn app.main:app &
sleep 2
for slug in acme globex initech umbrella; do
  TOKEN=$(curl -s localhost:8000/api/auth/login -H 'content-type: application/json' \
    -d "{\"email\":\"admin@$slug.test\",\"password\":\"DemoPass123!\"}" \
    | python -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
  echo "== $slug"
  curl -s localhost:8000/api/analytics/summary -H "authorization: Bearer $TOKEN"; echo
  curl -s "localhost:8000/api/analytics/timeseries?metric=net_revenue" -H "authorization: Bearer $TOKEN" \
    | python -c "import sys,json; print([round(float(p['value'])) for p in json.load(sys.stdin)])"
done
kill %1
```

Expected: four different summaries. The monthly lists show Acme rising, Globex falling in the second half, Initech roughly flat, and Umbrella with one bar about three times its neighbours. (Calendar months and the script's 30-day months do not line up exactly, so the first and last values are partial.) If a story is not visible, adjust that org's `multiplier` or `close_rate` and re-run.

- [ ] **Step 5: Lint, commit, PR**

Run: `ruff check . && ruff format --check . && pytest --cov=app --cov-fail-under=80`
Expected: clean and green (`scripts/` is outside the coverage target).

```bash
git add -A && git commit -m "feat: deterministic seed script with four tenant stories"
git push -u origin feat/seed-data
gh pr create --title "feat: seed data" --body "Adds scripts/seed.py (spec section 8): four orgs with distinct revenue stories, demo logins, audit entries."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch main && git pull
```

**Plan 3 done when:** both PRs are merged green and the four demo admins return visibly different analytics locally.

---

## Carried over from the Plan 1 review

Plan 1's code changed in review. Plan 3 tasks must follow what is on `main`, not Plan 1's original text:

- **Tenant context survives a commit.** `set_tenant` records the org in `session.info`, and an `after_begin` listener on `SessionLocal` re-applies it per transaction. Tests must build sessions with `SessionLocal(bind=conn, join_transaction_mode="create_savepoint")`. Never reuse a tenant-scoped session for another tenant.
- **Free-text inputs use `NoNulStr`** from `app/schemas/types.py` (rejects NUL with a 422). Use it for the invite `email`/`full_name` and the audit `action` filter.
- **Dates use UTC:** `datetime.now(UTC).date()`, not `date.today()`, in code and tests.
- **`page` is bounded** (`le=1_000_000`) in `PageDep`; unexpected errors return a 500 `internal_error` envelope and `DataError` maps to 422.
- **Every new table** gets ENABLE + FORCE row level security, a policy and explicit grants in its own migration.
- **Models do not declare the composite foreign keys**, so the seed must `flush()` parents before children (the script in Task 4 already does).

Open minors, fix when the file is next touched:
- The catch-all 500 runs outside `CORSMiddleware`, so a browser sees a CORS failure instead of the envelope. Fix before Plan 4 relies on it: handle unexpected exceptions in an HTTP middleware added inside CORS.
- `seeded` fixture should also `db.info.pop("org_id", None)` beside its tenant clear.
- Missing tests: member `DELETE /api/accounts/{id}` → 403; delete writes an audit entry; transactions `from`/`to` exactly on a row's date.
- The `DataError` → 422 handler logs nothing.
- 401 responses carry no `WWW-Authenticate: Bearer` header.

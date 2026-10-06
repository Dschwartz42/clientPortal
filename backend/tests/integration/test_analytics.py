import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from app.db import set_tenant
from app.models import Organization, Transaction, User


def _empty_org_admin(db, seeded) -> User:
    org = Organization(id=uuid.uuid4(), name="Empty Org", slug="empty", plan="free")
    set_tenant(db, org.id)
    db.add(org)
    db.flush()
    admin = User(
        id=uuid.uuid4(),
        org_id=org.id,
        email="admin@empty.test",
        password_hash=seeded.a.admin.password_hash,
        full_name="Empty Admin",
        role="admin",
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
    start = datetime.now(UTC).date() - timedelta(days=28)
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
    today = datetime.now(UTC).date()
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


def _add_charge(db, org, account, amount, occurred_at):
    db.add(
        Transaction(
            id=uuid.uuid4(),
            org_id=org.id,
            account_id=account.id,
            type="charge",
            amount=Decimal(amount),
            description="boundary",
            occurred_at=occurred_at,
        )
    )


def test_top_accounts_ordered_highest_first_and_limit_takes_the_top(client, db, seeded, auth):
    alpha, beta, gamma = seeded.a.accounts  # alpha already holds 1950.00 from the fixture
    set_tenant(db, seeded.a.org.id)
    now = datetime.now(UTC)
    _add_charge(db, seeded.a.org, beta, "3000.00", now - timedelta(days=3))
    _add_charge(db, seeded.a.org, gamma, "2500.00", now - timedelta(days=4))
    db.flush()

    headers = auth(seeded.a.member)
    r = client.get("/api/analytics/top-accounts", headers=headers)
    assert [(a["account_id"], a["net_revenue"]) for a in r.json()] == [
        (str(beta.id), "3000.00"),
        (str(gamma.id), "2500.00"),
        (str(alpha.id), "1950.00"),
    ]
    r = client.get("/api/analytics/top-accounts?limit=2", headers=headers)
    assert [a["account_id"] for a in r.json()] == [str(beta.id), str(gamma.id)]


def test_series_period_boundaries_are_utc_months_and_monday_weeks(client, db, seeded, auth):
    # 2020-01-31 is a Friday, 2020-02-02 a Sunday, 2020-02-03 a Monday. The fixture's own
    # transactions (5 to 45 days ago) are far outside the requested range.
    account = seeded.a.accounts[0]
    set_tenant(db, seeded.a.org.id)
    for amount, moment in [
        ("1.00", datetime(2020, 1, 31, 23, 59, 59, tzinfo=UTC)),  # last second of January
        ("10.00", datetime(2020, 2, 1, 0, 0, 0, tzinfo=UTC)),  # first second of February
        ("100.00", datetime(2020, 2, 2, 23, 59, 59, tzinfo=UTC)),  # last second of Sunday
        ("1000.00", datetime(2020, 2, 3, 0, 0, 0, tzinfo=UTC)),  # first second of Monday
    ]:
        _add_charge(db, seeded.a.org, account, amount, moment)
    db.flush()

    headers = auth(seeded.a.member)
    monthly = client.get(
        "/api/analytics/timeseries",
        params={
            "metric": "net_revenue",
            "interval": "month",
            "from": "2020-01-01",
            "to": "2020-02-29",
        },
        headers=headers,
    )
    assert monthly.json() == [
        {"period": "2020-01-01", "value": "1.00"},
        {"period": "2020-02-01", "value": "1110.00"},
    ]
    weekly = client.get(
        "/api/analytics/timeseries",
        params={
            "metric": "net_revenue",
            "interval": "week",
            "from": "2020-01-27",
            "to": "2020-02-09",
        },
        headers=headers,
    )
    # Week of Mon 2020-01-27 holds Jan 31, Feb 1 and Sunday Feb 2; Monday Feb 3 starts the next.
    assert weekly.json() == [
        {"period": "2020-01-27", "value": "111.00"},
        {"period": "2020-02-03", "value": "1000.00"},
    ]

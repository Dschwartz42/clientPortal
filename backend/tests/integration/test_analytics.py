import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from app.db import set_tenant
from app.models import Organization, User


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

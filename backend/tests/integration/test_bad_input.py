import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import DataError

from app.main import app

NEW_ACCOUNT = {"name": "New Client", "tier": "silver", "monthly_value": "250.00"}


def _assert_envelope(r, status, code):
    assert r.status_code == status
    assert r.headers["content-type"].startswith("application/json")
    assert r.json()["error"]["code"] == code


def test_login_with_nul_in_email_is_422(client, seeded):
    r = client.post("/api/auth/login", json={"email": "a\x00b@orga.test", "password": "x"})
    _assert_envelope(r, 422, "validation_error")


def test_search_with_nul_is_422(client, seeded, auth):
    r = client.get("/api/accounts?search=a%00", headers=auth(seeded.a.member))
    _assert_envelope(r, 422, "validation_error")


def test_create_account_with_nul_name_is_422(client, seeded, auth):
    r = client.post(
        "/api/accounts", json={**NEW_ACCOUNT, "name": "bad\x00name"}, headers=auth(seeded.a.admin)
    )
    _assert_envelope(r, 422, "validation_error")


def test_patch_account_with_nul_name_is_422(client, seeded, auth):
    r = client.patch(
        f"/api/accounts/{seeded.a.accounts[0].id}",
        json={"name": "bad\x00name"},
        headers=auth(seeded.a.admin),
    )
    _assert_envelope(r, 422, "validation_error")


@pytest.mark.parametrize("suffix", ["", "/transactions"])
def test_huge_page_is_422(client, seeded, auth, suffix):
    url = f"/api/accounts/{seeded.a.accounts[0].id}{suffix}" if suffix else "/api/accounts"
    r = client.get(f"{url}?page=4611686018427387904", headers=auth(seeded.a.member))
    _assert_envelope(r, 422, "validation_error")


def test_to_date_max_does_not_overflow(client, seeded, auth):
    r = client.get(
        f"/api/accounts/{seeded.a.accounts[0].id}/transactions?to=9999-12-31",
        headers=auth(seeded.a.member),
    )
    assert r.status_code == 200
    assert r.json()["total"] == 6


def test_unexpected_exception_returns_generic_500_envelope(client, seeded, auth, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("secret-internal-detail")

    monkeypatch.setattr("app.routers.accounts.net_revenue_between", boom)
    with TestClient(app, raise_server_exceptions=False) as quiet:
        r = quiet.get(f"/api/accounts/{seeded.a.accounts[0].id}", headers=auth(seeded.a.member))
    _assert_envelope(r, 500, "internal_error")
    assert "secret-internal-detail" not in r.text


def test_unexpected_exception_500_carries_cors_headers(client, seeded, auth, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("secret-internal-detail")

    monkeypatch.setattr("app.routers.accounts.net_revenue_between", boom)
    headers = {**auth(seeded.a.member), "Origin": "http://localhost:5173"}
    with TestClient(app, raise_server_exceptions=False) as quiet:
        r = quiet.get(f"/api/accounts/{seeded.a.accounts[0].id}", headers=headers)
    _assert_envelope(r, 500, "internal_error")
    assert "secret-internal-detail" not in r.text
    assert r.headers["access-control-allow-origin"] == "http://localhost:5173"


def test_timeseries_to_date_min_without_from_is_422(client, seeded, auth):
    r = client.get(
        "/api/analytics/timeseries?metric=net_revenue&to=0001-01-01",
        headers=auth(seeded.a.member),
    )
    _assert_envelope(r, 422, "validation_error")


def test_data_error_maps_to_422(client, seeded, auth, monkeypatch):
    def boom(*args, **kwargs):
        raise DataError("stmt", {}, Exception("bad data"))

    monkeypatch.setattr("app.routers.accounts.net_revenue_between", boom)
    r = client.get(f"/api/accounts/{seeded.a.accounts[0].id}", headers=auth(seeded.a.member))
    _assert_envelope(r, 422, "validation_error")

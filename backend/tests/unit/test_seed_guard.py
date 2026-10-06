from datetime import date, timedelta

import pytest
from sqlalchemy.engine import make_url

from scripts.seed import describe_target, eligible_counts, is_local_host


@pytest.mark.parametrize("host", ["localhost", "127.0.0.1", "::1", None, ""])
def test_local_hosts(host):
    assert is_local_host(host)


@pytest.mark.parametrize("host", ["pg-x.postgres.database.azure.com", "10.0.0.5", "db.example.com"])
def test_remote_hosts(host):
    assert not is_local_host(host)


def test_describe_target_has_database_host_user_but_not_password():
    url = make_url("postgresql+psycopg://portal_owner:s3cretpw@localhost:5432/portal")
    text = describe_target(url)
    assert "portal" in text and "localhost:5432" in text and "portal_owner" in text
    assert "s3cretpw" not in text


WS = date(2026, 1, 1)


def _counts(pairs, months=4):
    return eligible_counts(pairs, WS, months, 30)


def test_account_opened_before_window_counts_from_bucket_zero():
    assert _counts([(WS - timedelta(days=100), None)]) == [1, 1, 1, 1]


def test_account_opened_mid_window_starts_in_its_bucket():
    assert _counts([(WS + timedelta(days=45), None)]) == [0, 1, 1, 1]


def test_closed_account_stops_after_its_closing_bucket():
    pairs = [(WS - timedelta(days=100), WS + timedelta(days=45))]
    assert _counts(pairs) == [1, 1, 0, 0]


def test_account_opened_and_closed_in_same_bucket_counts_once():
    pairs = [(WS + timedelta(days=35), WS + timedelta(days=50))]
    assert _counts(pairs) == [0, 1, 0, 0]

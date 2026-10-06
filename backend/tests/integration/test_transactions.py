from datetime import date, timedelta


def _url(account):
    return f"/api/accounts/{account.id}/transactions"


def test_lists_newest_first_with_string_amounts(client, seeded, auth):
    r = client.get(_url(seeded.a.accounts[0]), headers=auth(seeded.a.member))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 6
    times = [t["occurred_at"] for t in body["items"]]
    assert times == sorted(times, reverse=True)
    assert body["items"][0] == {
        "id": body["items"][0]["id"],
        "account_id": str(seeded.a.accounts[0].id),
        "type": "charge",
        "amount": "1000.00",
        "description": "charge 5d ago",
        "occurred_at": body["items"][0]["occurred_at"],
    }


def test_from_and_to_filter_inclusively(client, seeded, auth):
    today = date.today()
    params = {"from": str(today - timedelta(days=13)), "to": str(today - timedelta(days=9))}
    r = client.get(_url(seeded.a.accounts[0]), params=params, headers=auth(seeded.a.member))
    assert sorted(t["amount"] for t in r.json()["items"]) == ["200.00", "500.00"]


def test_pagination(client, seeded, auth):
    r = client.get(
        _url(seeded.a.accounts[0]),
        params={"page": 2, "page_size": 4},
        headers=auth(seeded.a.member),
    )
    assert r.json()["total"] == 6 and len(r.json()["items"]) == 2


def test_account_without_transactions_returns_empty_list(client, seeded, auth):
    r = client.get(_url(seeded.a.accounts[1]), headers=auth(seeded.a.member))
    assert r.json()["items"] == [] and r.json()["total"] == 0


def test_other_orgs_account_is_404(client, seeded, auth):
    r = client.get(_url(seeded.b.accounts[0]), headers=auth(seeded.a.admin))
    assert r.status_code == 404


def test_bad_date_is_422(client, seeded, auth):
    r = client.get(
        _url(seeded.a.accounts[0]), params={"from": "yesterday"}, headers=auth(seeded.a.member)
    )
    assert r.status_code == 422

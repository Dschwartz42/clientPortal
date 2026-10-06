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


def test_action_filter_rejects_nul_characters(client, seeded, auth):
    r = client.get("/api/audit-log?action=account.%00created", headers=auth(seeded.a.admin))
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


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

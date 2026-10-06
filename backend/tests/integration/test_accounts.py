import uuid
from datetime import UTC, datetime

from sqlalchemy import text

from app.db import set_tenant

NEW_ACCOUNT = {"name": "New Client", "tier": "silver", "monthly_value": "250.00"}


def _row(db, org_id, account_id):
    set_tenant(db, org_id)
    return db.execute(
        text("SELECT org_id, name, status, closed_at FROM accounts WHERE id = :id"),
        {"id": account_id},
    ).first()


def test_list_requires_token(client, seeded):
    assert client.get("/api/accounts").status_code == 401


def test_list_returns_only_own_org(client, seeded, auth):
    r = client.get("/api/accounts", headers=auth(seeded.a.member))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert body["page"] == 1 and body["page_size"] == 25
    assert {a["name"] for a in body["items"]} == {"Org A Alpha", "Org A Beta", "Org A Gamma"}
    assert body["items"][0]["monthly_value"] == "1000.00"  # money is a string


def test_list_filters_search_and_sort(client, seeded, auth):
    headers = auth(seeded.a.member)
    active = client.get("/api/accounts?status=active", headers=headers).json()
    assert active["total"] == 2
    gold = client.get("/api/accounts?tier=gold", headers=headers).json()
    assert [a["name"] for a in gold["items"]] == ["Org A Alpha"]
    found = client.get("/api/accounts?search=bet", headers=headers).json()
    assert [a["name"] for a in found["items"]] == ["Org A Beta"]
    by_value = client.get("/api/accounts?sort=-monthly_value", headers=headers).json()
    assert [a["monthly_value"] for a in by_value["items"]] == ["1000.00", "500.00", "100.00"]


def test_search_treats_wildcards_literally(client, seeded, auth):
    headers = auth(seeded.a.member)
    assert client.get("/api/accounts?search=%25", headers=headers).json()["total"] == 0
    assert client.get("/api/accounts?search=_", headers=headers).json()["total"] == 0


def test_unknown_sort_field_is_422(client, seeded, auth):
    r = client.get("/api/accounts?sort=password_hash", headers=auth(seeded.a.member))
    assert r.status_code == 422


def test_pagination_total_and_page_size_cap(client, seeded, auth):
    headers = auth(seeded.a.member)
    page2 = client.get("/api/accounts?page=2&page_size=2", headers=headers).json()
    assert page2["total"] == 3 and len(page2["items"]) == 1
    capped = client.get("/api/accounts?page_size=500", headers=headers).json()
    assert capped["page_size"] == 100
    beyond = client.get("/api/accounts?page=99", headers=headers).json()
    assert beyond["items"] == [] and beyond["total"] == 3


def test_get_detail_includes_owner_and_30d_revenue(client, seeded, auth):
    alpha = seeded.a.accounts[0]
    r = client.get(f"/api/accounts/{alpha.id}", headers=auth(seeded.a.member))
    assert r.status_code == 200
    assert r.json()["owner_name"] == "Org A Admin"
    assert r.json()["revenue_30d"] == "1250.00"


def test_get_other_orgs_account_is_404(client, seeded, auth):
    r = client.get(f"/api/accounts/{seeded.b.accounts[0].id}", headers=auth(seeded.a.admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_patch_other_orgs_account_is_404_and_row_unchanged(client, db, seeded, auth):
    target = seeded.b.accounts[0]
    r = client.patch(
        f"/api/accounts/{target.id}", json={"name": "Hijacked"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 404
    assert _row(db, seeded.b.org.id, target.id).name == "Org B Alpha"


def test_delete_other_orgs_account_is_404(client, db, seeded, auth):
    target = seeded.b.accounts[1]
    r = client.delete(f"/api/accounts/{target.id}", headers=auth(seeded.a.admin))
    assert r.status_code == 404
    assert _row(db, seeded.b.org.id, target.id) is not None


def test_create_uses_callers_org_even_if_body_sends_another(client, db, seeded, auth):
    body = {**NEW_ACCOUNT, "org_id": str(seeded.b.org.id)}
    r = client.post("/api/accounts", json=body, headers=auth(seeded.a.admin))
    assert r.status_code == 201
    created = r.json()
    assert created["status"] == "active"
    assert created["opened_at"] == datetime.now(UTC).date().isoformat()
    assert _row(db, seeded.a.org.id, created["id"]).org_id == seeded.a.org.id
    assert _row(db, seeded.b.org.id, created["id"]) is None


def test_create_writes_audit_log(client, db, seeded, auth):
    created = client.post("/api/accounts", json=NEW_ACCOUNT, headers=auth(seeded.a.admin)).json()
    set_tenant(db, seeded.a.org.id)
    entry = db.execute(
        text("SELECT action, actor_user_id FROM audit_log WHERE entity_id = :id"),
        {"id": created["id"]},
    ).one()
    assert entry.action == "account.created"
    assert entry.actor_user_id == seeded.a.admin.id


def test_member_cannot_create(client, seeded, auth):
    r = client.post("/api/accounts", json=NEW_ACCOUNT, headers=auth(seeded.a.member))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden"


def test_create_rejects_owner_from_another_org(client, seeded, auth):
    body = {**NEW_ACCOUNT, "owner_user_id": str(seeded.b.admin.id)}
    r = client.post("/api/accounts", json=body, headers=auth(seeded.a.admin))
    assert r.status_code == 422


def test_create_rejects_negative_value_and_blank_name(client, seeded, auth):
    headers = auth(seeded.a.admin)
    negative = {**NEW_ACCOUNT, "monthly_value": "-1"}
    blank = {**NEW_ACCOUNT, "name": "   "}
    assert client.post("/api/accounts", json=negative, headers=headers).status_code == 422
    assert client.post("/api/accounts", json=blank, headers=headers).status_code == 422


def test_patch_closing_sets_closed_at_and_audits_before_after(client, db, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.patch(
        f"/api/accounts/{beta.id}", json={"status": "closed"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 200
    assert r.json()["closed_at"] == datetime.now(UTC).date().isoformat()
    set_tenant(db, seeded.a.org.id)
    details = db.execute(
        text("SELECT details FROM audit_log WHERE entity_id = :id AND action = 'account.updated'"),
        {"id": beta.id},
    ).scalar_one()
    assert details["before"]["status"] == "active"
    assert details["after"]["status"] == "closed"


def test_patch_reopening_clears_closed_at(client, seeded, auth):
    gamma = seeded.a.accounts[2]
    r = client.patch(
        f"/api/accounts/{gamma.id}", json={"status": "active"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 200
    assert r.json()["closed_at"] is None


def test_patch_explicit_null_for_required_field_is_422(client, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.patch(f"/api/accounts/{beta.id}", json={"name": None}, headers=auth(seeded.a.admin))
    assert r.status_code == 422


def test_member_cannot_patch(client, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.patch(f"/api/accounts/{beta.id}", json={"name": "X"}, headers=auth(seeded.a.member))
    assert r.status_code == 403


def test_delete_account_with_transactions_is_409(client, seeded, auth):
    alpha = seeded.a.accounts[0]
    r = client.delete(f"/api/accounts/{alpha.id}", headers=auth(seeded.a.admin))
    assert r.status_code == 409
    assert "Close it instead" in r.json()["error"]["message"]


def test_delete_account_without_transactions(client, db, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.delete(f"/api/accounts/{beta.id}", headers=auth(seeded.a.admin))
    assert r.status_code == 204
    assert _row(db, seeded.a.org.id, beta.id) is None


def test_get_unknown_account_is_404(client, seeded, auth):
    r = client.get(f"/api/accounts/{uuid.uuid4()}", headers=auth(seeded.a.admin))
    assert r.status_code == 404


def test_patch_same_value_in_different_format_writes_no_audit_entry(client, db, seeded, auth):
    alpha = seeded.a.accounts[0]
    r = client.patch(
        f"/api/accounts/{alpha.id}", json={"monthly_value": "1000"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 200
    assert r.json()["monthly_value"] == "1000.00"
    set_tenant(db, seeded.a.org.id)
    count = db.execute(
        text("SELECT count(*) FROM audit_log WHERE entity_id = :id"), {"id": alpha.id}
    ).scalar_one()
    assert count == 0


def test_patch_audit_values_are_normalized(client, db, seeded, auth):
    alpha = seeded.a.accounts[0]
    r = client.patch(
        f"/api/accounts/{alpha.id}", json={"monthly_value": "1200"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 200
    set_tenant(db, seeded.a.org.id)
    details = db.execute(
        text("SELECT details FROM audit_log WHERE entity_id = :id AND action = 'account.updated'"),
        {"id": alpha.id},
    ).scalar_one()
    assert details == {
        "before": {"monthly_value": "1000.00"},
        "after": {"monthly_value": "1200.00"},
    }


def test_member_cannot_delete(client, seeded, auth):
    r = client.delete(f"/api/accounts/{seeded.a.accounts[1].id}", headers=auth(seeded.a.member))
    assert r.status_code == 403


def test_delete_account_without_transactions_writes_audit_entry(client, db, seeded, auth):
    beta = seeded.a.accounts[1]
    assert (
        client.delete(f"/api/accounts/{beta.id}", headers=auth(seeded.a.admin)).status_code == 204
    )
    set_tenant(db, seeded.a.org.id)
    entry = db.execute(
        text("SELECT action, actor_user_id FROM audit_log WHERE entity_id = :id"),
        {"id": beta.id},
    ).one()
    assert entry.action == "account.deleted"
    assert entry.actor_user_id == seeded.a.admin.id


def test_member_can_get_account_in_own_org(client, seeded, auth):
    r = client.get(f"/api/accounts/{seeded.a.accounts[1].id}", headers=auth(seeded.a.member))
    assert r.status_code == 200

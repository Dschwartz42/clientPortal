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


def test_invite_rejects_nul_characters(client, seeded, auth):
    headers = auth(seeded.a.admin)
    bad_email = {**INVITE, "email": "a\x00b@orga.test"}
    bad_name = {**INVITE, "full_name": "New\x00Person"}
    assert client.post("/api/users", json=bad_email, headers=headers).status_code == 422
    assert client.post("/api/users", json=bad_name, headers=headers).status_code == 422


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


def test_deactivated_users_token_stops_working_and_reactivation_restores_it(client, seeded, auth):
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

import logging
from contextlib import contextmanager

from sqlalchemy import event, text

from app.db import engine, set_tenant

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


def test_member_cannot_patch_user(client, seeded, auth):
    r = _patch(client, auth(seeded.a.member), seeded.a.member, {"role": "admin"})
    assert r.status_code == 403


def test_deactivate_then_reactivate_writes_audit_rows_in_order(client, db, seeded, auth):
    admin = auth(seeded.a.admin)
    assert _patch(client, admin, seeded.a.member, {"is_active": False}).status_code == 200
    assert _patch(client, admin, seeded.a.member, {"is_active": True}).status_code == 200
    set_tenant(db, seeded.a.org.id)
    actions = (
        db.execute(
            text(
                "SELECT action FROM audit_log WHERE entity_id = :id AND action LIKE 'user.%' "
                "ORDER BY id"
            ),
            {"id": seeded.a.member.id},
        )
        .scalars()
        .all()
    )
    assert actions == ["user.deactivated", "user.reactivated"]


@contextmanager
def _before_first_admin_lock(conn, statements):
    """Run raw SQL on the test connection just before the first FOR UPDATE statement."""
    state = {"done": False}

    def hook(connection, cursor, statement, parameters, context, executemany):
        if state["done"] or "FOR UPDATE" not in statement:
            return
        state["done"] = True
        for sql, params in statements:
            connection.execute(text(sql), params)

    event.listen(engine, "before_cursor_execute", hook)
    try:
        yield
    finally:
        event.remove(engine, "before_cursor_execute", hook)


def _set_role(user, role):
    return ("UPDATE users SET role = :role WHERE id = :id", {"role": role, "id": user.id})


def _active_admin_count(db, org):
    set_tenant(db, org.id)
    return db.execute(
        text("SELECT count(*) FROM users WHERE role = 'admin' AND is_active")
    ).scalar_one()


def test_stale_target_cannot_leave_org_without_an_active_admin(client, conn, db, seeded, auth):
    # T2 (admin A deactivates X) has read X as a member. Before it locks the admins,
    # T1 promotes X and T3 (X) demotes A, so X is now the only admin.
    a, x = seeded.a.admin, seeded.a.member
    headers = auth(a)
    with _before_first_admin_lock(conn, [_set_role(x, "admin"), _set_role(a, "member")]):
        r = _patch(client, headers, x, {"is_active": False})
    assert _active_admin_count(db, seeded.a.org) >= 1, "organization left with no active admin"
    assert r.status_code in (403, 409), r.json()


def test_actor_demoted_while_waiting_is_forbidden(client, conn, db, seeded, auth):
    a, x = seeded.a.admin, seeded.a.member
    headers = auth(a)
    with _before_first_admin_lock(conn, [_set_role(x, "admin"), _set_role(a, "member")]):
        r = _patch(client, headers, x, {"role": "member"})
    assert r.status_code == 403
    assert r.json()["error"] == {"code": "forbidden", "message": "Admin role required"}


def test_target_is_re_read_after_the_admin_lock(client, conn, db, seeded, auth):
    # The target X is a member when the request starts; a concurrent change promotes X
    # before the lock is taken. The handler must act on the fresh row, so demoting X is
    # a real change (before: admin) and is audited as such.
    a, x = seeded.a.admin, seeded.a.member
    headers = auth(a)
    with _before_first_admin_lock(conn, [_set_role(x, "admin")]):
        r = _patch(client, headers, x, {"role": "member"})
    assert r.status_code == 200, r.json()
    set_tenant(db, seeded.a.org.id)
    role = db.execute(text("SELECT role FROM users WHERE id = :id"), {"id": x.id}).scalar_one()
    assert role == "member"
    details = (
        db.execute(
            text(
                "SELECT details FROM audit_log"
                " WHERE entity_id = :id AND action = 'user.role_changed'"
            ),
            {"id": x.id},
        )
        .scalars()
        .all()
    )
    assert details == [{"before": {"role": "admin"}, "after": {"role": "member"}}]


def test_database_errors_do_not_log_parameters(client, conn, seeded, auth, caplog):
    def break_insert(connection, cursor, statement, parameters, context, executemany):
        if statement.lstrip().startswith("INSERT INTO users"):
            statement = statement.replace("INSERT INTO users", "INSERT INTO users_missing", 1)
        return statement, parameters

    event.listen(engine, "before_cursor_execute", break_insert, retval=True)
    try:
        with caplog.at_level(logging.ERROR, logger="app.errors"):
            r = client.post("/api/users", json=INVITE, headers=auth(seeded.a.admin))
    finally:
        event.remove(engine, "before_cursor_execute", break_insert)
    assert r.status_code == 500
    records = [rec for rec in caplog.records if rec.name == "app.errors"]
    assert records
    logged = caplog.text
    assert "users_missing" in logged  # the failure itself was logged
    assert "$argon2" not in logged
    assert INVITE["email"] not in logged


def test_invite_response_is_not_cacheable(client, seeded, auth):
    r = client.post("/api/users", json=INVITE, headers=auth(seeded.a.admin))
    assert r.status_code == 201
    assert r.headers["cache-control"] == "no-store"


def test_is_active_must_be_a_real_boolean(client, seeded, auth):
    headers = auth(seeded.a.admin)
    for value in ["yes", 1, "on", "true"]:
        r = _patch(client, headers, seeded.a.member, {"is_active": value})
        assert r.status_code == 422, value
        assert r.json()["error"]["message"].startswith("body.is_active:")

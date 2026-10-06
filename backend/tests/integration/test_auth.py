import uuid

import jwt

from app.config import settings
from app.db import set_tenant


def _login(client, email, password):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _deactivate(db, user):
    set_tenant(db, user.org_id)
    user.is_active = False
    db.flush()


def test_login_success_returns_token_and_user(client, seeded):
    r = _login(client, "admin@orga.test", seeded.password)
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["user"]["email"] == "admin@orga.test"
    assert body["user"]["role"] == "admin"
    assert body["user"]["org_name"] == "Org A"


def test_login_is_case_insensitive_on_email(client, seeded):
    assert _login(client, " Admin@OrgA.test ", seeded.password).status_code == 200


def test_wrong_password_and_unknown_email_are_indistinguishable(client, seeded):
    wrong = _login(client, "admin@orga.test", "nope")
    unknown = _login(client, "nobody@nowhere.test", "nope")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert wrong.json()["error"]["code"] == "invalid_credentials"


def test_inactive_user_cannot_log_in(client, db, seeded):
    _deactivate(db, seeded.a.member)
    assert _login(client, "member@orga.test", seeded.password).status_code == 401


def test_login_token_works_on_me(client, seeded):
    token = _login(client, "member@orgb.test", seeded.password).json()["access_token"]
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["org_name"] == "Org B"
    assert r.json()["role"] == "member"


def test_no_token_is_401(client, seeded):
    r = client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "not_authenticated"


def test_garbage_token_is_401(client, seeded):
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer not.a.jwt"})
    assert r.status_code == 401


def test_signed_token_with_non_uuid_subject_is_401(client, seeded):
    token = jwt.encode(
        {"sub": "42", "org_id": "nope", "role": "admin", "exp": 9999999999},
        settings.jwt_secret,
        algorithm="HS256",
    )
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_token_for_unknown_user_is_401(client, seeded, auth):
    ghost = type(seeded.a.admin)(id=uuid.uuid4(), org_id=seeded.a.org.id, role="admin")
    assert client.get("/api/auth/me", headers=auth(ghost)).status_code == 401


def test_deactivated_users_existing_token_is_401(client, db, seeded, auth):
    headers = auth(seeded.a.member)
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    _deactivate(db, seeded.a.member)
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_validation_error_uses_error_envelope(client):
    r = client.post("/api/auth/login", json={"email": "a@b.test"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_unknown_route_uses_error_envelope(client):
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"

import uuid

import jwt
import pytest

from app.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


def test_hash_verifies_correct_password_and_rejects_wrong_one():
    hashed = hash_password("s3cret-pass")
    assert hashed != "s3cret-pass"
    assert verify_password("s3cret-pass", hashed) is True
    assert verify_password("wrong", hashed) is False


def test_verify_rejects_garbage_hash():
    assert verify_password("anything", "not-a-hash") is False


def test_jwt_round_trip():
    user_id, org_id = uuid.uuid4(), uuid.uuid4()
    claims = decode_access_token(create_access_token(user_id, org_id, "admin"))
    assert claims["sub"] == str(user_id)
    assert claims["org_id"] == str(org_id)
    assert claims["role"] == "admin"
    assert claims["exp"] - claims["iat"] == 60 * 60


def test_expired_token_rejected():
    token = create_access_token(uuid.uuid4(), uuid.uuid4(), "member", expires_minutes=-1)
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(token)


def test_tampered_token_rejected():
    forged = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "role": "admin", "exp": 9999999999},
        "some-other-secret-0123456789-0123456789",
        algorithm="HS256",
    )
    with pytest.raises(jwt.InvalidSignatureError):
        decode_access_token(forged)


def test_token_without_exp_rejected():
    from app.config import settings

    token = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "role": "admin"},
        settings.jwt_secret,
        algorithm="HS256",
    )
    with pytest.raises(jwt.MissingRequiredClaimError):
        decode_access_token(token)

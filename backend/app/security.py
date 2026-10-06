import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.config import settings

ALGORITHM = "HS256"
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(
    user_id: uuid.UUID, org_id: uuid.UUID, role: str, expires_minutes: int | None = None
) -> str:
    now = datetime.now(UTC)
    minutes = settings.jwt_expire_minutes if expires_minutes is None else expires_minutes
    claims = {
        "sub": str(user_id),
        "org_id": str(org_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    return jwt.encode(claims, settings.jwt_secret, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    return jwt.decode(
        token,
        settings.jwt_secret,
        algorithms=[ALGORITHM],
        options={"require": ["exp", "sub", "org_id", "role"]},
    )

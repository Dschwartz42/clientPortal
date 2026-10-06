from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db import set_tenant
from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.models import Organization, User
from app.schemas.auth import LoginIn, LoginOut, MeOut
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Verified against when the email is unknown, so both failure paths cost one argon2 verify.
_DUMMY_HASH = hash_password("dummy-password-for-timing")
_FIND_USER = text(
    "SELECT id, org_id, password_hash, is_active FROM auth_find_user(CAST(:email AS citext))"
)


def _me(db: Session, user: User) -> MeOut:
    org_name = db.scalar(select(Organization.name).where(Organization.id == user.org_id))
    return MeOut(
        id=user.id,
        email=user.email,
        full_name=user.full_name,
        role=user.role,
        org_id=user.org_id,
        org_name=org_name,
    )


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, db: Db) -> LoginOut:
    row = db.execute(_FIND_USER, {"email": body.email.strip()}).first()
    password_ok = verify_password(body.password, row.password_hash if row else _DUMMY_HASH)
    if row is None or not password_ok or not row.is_active:
        raise ApiError(401, "invalid_credentials", "Invalid email or password")

    set_tenant(db, row.org_id)
    user = db.scalar(select(User).where(User.id == row.id, User.org_id == row.org_id))
    if user is None:
        raise ApiError(401, "invalid_credentials", "Invalid email or password")
    user.last_login_at = datetime.now(UTC)
    out = LoginOut(
        access_token=create_access_token(user.id, user.org_id, user.role), user=_me(db, user)
    )
    db.commit()
    return out


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser, db: Db) -> MeOut:
    return _me(db, user)

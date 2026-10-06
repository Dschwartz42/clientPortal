import uuid
from typing import Annotated

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, set_tenant
from app.errors import ApiError
from app.models import User
from app.security import decode_access_token

_bearer = HTTPBearer(auto_error=False)

Db = Annotated[Session, Depends(get_db)]


def get_current_user(
    db: Db, credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]
) -> User:
    """Authenticate, then scope this request's transaction to the user's tenant."""
    if credentials is None:
        raise ApiError(401, "not_authenticated", "Authentication required")
    try:
        claims = decode_access_token(credentials.credentials)
        user_id = uuid.UUID(claims["sub"])
        org_id = uuid.UUID(claims["org_id"])
    except (jwt.InvalidTokenError, KeyError, ValueError, TypeError, AttributeError):
        raise ApiError(401, "invalid_token", "Invalid or expired token") from None

    set_tenant(db, org_id)
    # Loaded on every request, so deactivation and role changes apply immediately.
    user = db.scalar(select(User).where(User.id == user_id, User.org_id == org_id))
    if user is None or not user.is_active:
        raise ApiError(401, "invalid_token", "Invalid or expired token")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_admin(user: CurrentUser) -> User:
    if user.role != "admin":
        raise ApiError(403, "forbidden", "Admin role required")
    return user


AdminUser = Annotated[User, Depends(require_admin)]

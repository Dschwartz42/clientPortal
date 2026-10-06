import secrets
import uuid

from fastapi import APIRouter, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.deps import AdminUser, Db
from app.errors import ApiError
from app.models import User
from app.pagination import PageDep
from app.schemas.common import Paginated
from app.schemas.users import InvitedUserOut, UserInvite, UserOut, UserUpdate
from app.security import hash_password
from app.services import audit
from app.services.users import check_user_update

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("", response_model=Paginated[UserOut])
def list_users(admin: AdminUser, db: Db, page: PageDep):
    conditions = [User.org_id == admin.org_id]
    total = db.scalar(select(func.count()).select_from(User).where(*conditions))
    rows = db.scalars(
        select(User)
        .where(*conditions)
        .order_by(User.full_name, User.id)
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    return {"items": rows, "total": total, "page": page.page, "page_size": page.page_size}


@router.post("", response_model=InvitedUserOut, status_code=201)
def invite_user(body: UserInvite, admin: AdminUser, db: Db, response: Response):
    temporary_password = secrets.token_urlsafe(12)
    user = User(
        id=uuid.uuid4(),
        org_id=admin.org_id,
        email=body.email,
        password_hash=hash_password(temporary_password),
        full_name=body.full_name,
        role=body.role,
        is_active=True,
    )
    # Emails are unique across all tenants, and RLS hides other tenants' users, so a
    # pre-check cannot see every conflict. Let the constraint decide, inside a savepoint
    # so a conflict does not abort the request's transaction.
    try:
        with db.begin_nested():
            db.add(user)
            db.flush()
    except IntegrityError:
        raise ApiError(409, "email_taken", "A user with this email already exists") from None

    db.refresh(user)
    audit.record(
        db,
        admin,
        "user.invited",
        "user",
        user.id,
        {"after": {"email": user.email, "role": user.role}},
    )
    out = InvitedUserOut(
        **UserOut.model_validate(user).model_dump(), temporary_password=temporary_password
    )
    db.commit()
    response.headers["Cache-Control"] = "no-store"  # carries a temporary credential
    return out


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: uuid.UUID, body: UserUpdate, admin: AdminUser, db: Db):
    # Lock the org's active admins first so two concurrent changes cannot both pass the
    # check. Everything is read after the lock: a row read earlier may be stale.
    admin_ids = db.scalars(
        select(User.id)
        .where(User.org_id == admin.org_id, User.role == "admin", User.is_active.is_(True))
        .order_by(User.id)
        .with_for_update()
    ).all()
    if admin.id not in admin_ids:
        # Demoted or deactivated while this request waited for the lock.
        raise ApiError(403, "forbidden", "Admin role required")
    # populate_existing refreshes rows already in the session's identity map.
    target = db.scalar(
        select(User)
        .where(User.id == user_id, User.org_id == admin.org_id)
        .execution_options(populate_existing=True)
    )
    if target is None:
        raise ApiError(404, "not_found", "User not found")

    changes = body.model_dump(exclude_unset=True)
    new_role = changes.get("role", target.role)
    new_is_active = changes.get("is_active", target.is_active)
    violation = check_user_update(
        actor_id=admin.id,
        target_id=target.id,
        target_role=target.role,
        target_is_active=target.is_active,
        new_role=new_role,
        new_is_active=new_is_active,
        other_active_admins=len([i for i in admin_ids if i != target.id]),
    )
    if violation:
        raise ApiError(409, *violation)

    if new_role != target.role:
        audit.record(
            db,
            admin,
            "user.role_changed",
            "user",
            target.id,
            {"before": {"role": target.role}, "after": {"role": new_role}},
        )
        target.role = new_role
    if new_is_active != target.is_active:
        action = "user.reactivated" if new_is_active else "user.deactivated"
        audit.record(db, admin, action, "user", target.id, {"after": {"is_active": new_is_active}})
        target.is_active = new_is_active

    db.flush()
    out = UserOut.model_validate(target)
    db.commit()
    return out

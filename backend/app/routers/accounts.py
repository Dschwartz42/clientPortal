import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Query, Response
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from app.deps import AdminUser, CurrentUser, Db
from app.errors import ApiError
from app.models import Account, Transaction, User
from app.pagination import PageDep
from app.schemas.accounts import (
    AccountCreate,
    AccountDetail,
    AccountOut,
    AccountUpdate,
    Status,
    Tier,
)
from app.schemas.common import Paginated
from app.schemas.types import NoNulStr
from app.services import audit
from app.services.analytics import net_revenue_between

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

SORTABLE = {
    "name": Account.name,
    "monthly_value": Account.monthly_value,
    "opened_at": Account.opened_at,
    "created_at": Account.created_at,
    "status": Account.status,
    "tier": Account.tier,
}
AUDITED = ("name", "status", "tier", "monthly_value", "owner_user_id", "opened_at", "closed_at")


def get_account_or_404(db: Session, user: User, account_id: uuid.UUID) -> Account:
    # The explicit org_id filter is defense in depth; RLS would hide the row anyway.
    account = db.scalar(
        select(Account).where(Account.id == account_id, Account.org_id == user.org_id)
    )
    if account is None:
        raise ApiError(404, "not_found", "Account not found")
    return account


def _check_owner(db: Session, user: User, owner_user_id: uuid.UUID | None) -> None:
    if owner_user_id is None:
        return
    found = db.scalar(select(User.id).where(User.id == owner_user_id, User.org_id == user.org_id))
    if found is None:
        raise ApiError(422, "validation_error", "owner_user_id: no such user in this organization")


def _snapshot(account: Account, fields=AUDITED) -> dict:
    return {
        field: None if getattr(account, field) is None else str(getattr(account, field))
        for field in fields
    }


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=Paginated[AccountOut])
def list_accounts(
    user: CurrentUser,
    db: Db,
    page: PageDep,
    status: Status | None = None,
    tier: Tier | None = None,
    search: Annotated[NoNulStr | None, Query()] = None,
    sort: str = "name",
):
    column = SORTABLE.get(sort.removeprefix("-"))
    if column is None:
        raise ApiError(422, "validation_error", f"sort: unsupported field '{sort}'")
    conditions = [Account.org_id == user.org_id]
    if status:
        conditions.append(Account.status == status)
    if tier:
        conditions.append(Account.tier == tier)
    if search and search.strip():
        pattern = f"%{_escape_like(search.strip())}%"
        conditions.append(Account.name.ilike(pattern, escape="\\"))

    total = db.scalar(select(func.count()).select_from(Account).where(*conditions))
    order = column.desc() if sort.startswith("-") else column.asc()
    rows = db.scalars(
        select(Account)
        .where(*conditions)
        .order_by(order, Account.id)
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    return {"items": rows, "total": total, "page": page.page, "page_size": page.page_size}


@router.post("", response_model=AccountOut, status_code=201)
def create_account(body: AccountCreate, admin: AdminUser, db: Db):
    _check_owner(db, admin, body.owner_user_id)
    today = date.today()
    account = Account(
        id=uuid.uuid4(),
        org_id=admin.org_id,  # always the caller's org; the body has no org_id field
        name=body.name,
        status=body.status,
        tier=body.tier,
        monthly_value=body.monthly_value,
        owner_user_id=body.owner_user_id,
        opened_at=body.opened_at or today,
        closed_at=today if body.status == "closed" else None,
    )
    db.add(account)
    db.flush()
    db.refresh(account)
    audit.record(db, admin, "account.created", "account", account.id, {"after": _snapshot(account)})
    out = AccountOut.model_validate(account)
    db.commit()
    return out


@router.get("/{account_id}", response_model=AccountDetail)
def get_account(account_id: uuid.UUID, user: CurrentUser, db: Db):
    account = get_account_or_404(db, user, account_id)
    owner_name = None
    if account.owner_user_id is not None:
        owner_name = db.scalar(
            select(User.full_name).where(
                User.id == account.owner_user_id, User.org_id == user.org_id
            )
        )
    now = datetime.now(UTC)
    revenue = net_revenue_between(db, user.org_id, now - timedelta(days=30), now, account.id)
    return AccountDetail(
        **AccountOut.model_validate(account).model_dump(),
        owner_name=owner_name,
        revenue_30d=revenue,
    )


@router.patch("/{account_id}", response_model=AccountOut)
def update_account(account_id: uuid.UUID, body: AccountUpdate, admin: AdminUser, db: Db):
    account = get_account_or_404(db, admin, account_id)
    changes = body.model_dump(exclude_unset=True)
    if "owner_user_id" in changes:
        _check_owner(db, admin, changes["owner_user_id"])

    before = _snapshot(account)
    for field, value in changes.items():
        setattr(account, field, value)
    if "status" in changes and str(changes["status"]) != before["status"]:
        account.closed_at = date.today() if changes["status"] == "closed" else None
    db.flush()
    db.refresh(account)
    after = _snapshot(account)

    changed = [field for field in AUDITED if before[field] != after[field]]
    if changed:
        audit.record(
            db,
            admin,
            "account.updated",
            "account",
            account.id,
            {
                "before": {field: before[field] for field in changed},
                "after": {field: after[field] for field in changed},
            },
        )
    out = AccountOut.model_validate(account)
    db.commit()
    return out


@router.delete("/{account_id}", status_code=204)
def delete_account(account_id: uuid.UUID, admin: AdminUser, db: Db):
    account = get_account_or_404(db, admin, account_id)
    has_transactions = db.scalar(
        select(
            exists().where(Transaction.org_id == admin.org_id, Transaction.account_id == account.id)
        )
    )
    if has_transactions:
        raise ApiError(
            409,
            "account_has_transactions",
            "This account has transactions and cannot be deleted. Close it instead.",
        )
    audit.record(
        db, admin, "account.deleted", "account", account.id, {"before": _snapshot(account)}
    )
    db.delete(account)
    db.commit()
    return Response(status_code=204)

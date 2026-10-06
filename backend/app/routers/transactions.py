import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.deps import CurrentUser, Db
from app.models import Transaction
from app.pagination import PageDep
from app.routers.accounts import get_account_or_404
from app.schemas.common import Paginated
from app.schemas.transactions import TransactionOut

router = APIRouter(prefix="/api/accounts", tags=["transactions"])


def _start_of_day(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=UTC)


@router.get("/{account_id}/transactions", response_model=Paginated[TransactionOut])
def list_transactions(
    account_id: uuid.UUID,
    user: CurrentUser,
    db: Db,
    page: PageDep,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
):
    account = get_account_or_404(db, user, account_id)
    conditions = [Transaction.org_id == user.org_id, Transaction.account_id == account.id]
    if from_ is not None:
        conditions.append(Transaction.occurred_at >= _start_of_day(from_))
    if to is not None and to < date.max:  # date.max + 1 day would overflow; no upper bound needed
        conditions.append(Transaction.occurred_at < _start_of_day(to + timedelta(days=1)))

    total = db.scalar(select(func.count()).select_from(Transaction).where(*conditions))
    rows = db.scalars(
        select(Transaction)
        .where(*conditions)
        .order_by(Transaction.occurred_at.desc(), Transaction.id)
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    return {"items": rows, "total": total, "page": page.page, "page_size": page.page_size}

import uuid
from collections.abc import Iterable
from datetime import datetime
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import Transaction

CENTS = Decimal("0.01")


def money(value: Decimal | int | None) -> Decimal:
    return Decimal(value or 0).quantize(CENTS)


def net_revenue(items: Iterable[tuple[str, Decimal]]) -> Decimal:
    """Net revenue = charges - refunds - credits. Amounts are always positive; type sets the sign."""
    total = sum((amount if type_ == "charge" else -amount for type_, amount in items), Decimal(0))
    return money(total)


def pct_change(current: Decimal, previous: Decimal) -> float | None:
    if previous == 0:
        return None
    return round(float((current - previous) / abs(previous) * 100), 2)


def signed_amount():
    """SQL form of net_revenue's sign rule."""
    return case((Transaction.type == "charge", Transaction.amount), else_=-Transaction.amount)


def net_revenue_between(
    db: Session,
    org_id: uuid.UUID,
    start: datetime,
    end: datetime,
    account_id: uuid.UUID | None = None,
) -> Decimal:
    stmt = select(func.sum(signed_amount())).where(
        Transaction.org_id == org_id,
        Transaction.occurred_at >= start,
        Transaction.occurred_at < end,
    )
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    return money(db.scalar(stmt))

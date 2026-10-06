from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from sqlalchemy import and_, func, select, text

from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.models import Account, Transaction
from app.schemas.analytics import SummaryOut, TimeseriesPoint, TopAccountOut
from app.services.analytics import money, net_revenue_between, pct_change, signed_amount

router = APIRouter(prefix="/api/analytics", tags=["analytics"])

MAX_RANGE_DAYS = 366 * 5
STEP = {"week": "1 week", "month": "1 month"}

# generate_series produces every period in the range, so periods with no rows
# still appear (LEFT JOIN + COALESCE/COUNT gives them a zero).
_PERIODS = """
    generate_series(
        date_trunc(:unit, CAST(:start AS timestamp)),
        date_trunc(:unit, CAST(:end AS timestamp)),
        CAST(:step AS interval)
    ) AS gs(period)
"""
TIMESERIES_SQL = {
    "net_revenue": text(
        f"""
        SELECT CAST(gs.period AS date) AS period,
               COALESCE(SUM(CASE WHEN t.type = 'charge' THEN t.amount ELSE -t.amount END), 0)
                   AS value
        FROM {_PERIODS}
        LEFT JOIN transactions t
          ON t.org_id = :org_id
         AND date_trunc(:unit, t.occurred_at AT TIME ZONE 'UTC') = gs.period
        GROUP BY gs.period
        ORDER BY gs.period
        """
    ),
    "new_accounts": text(
        f"""
        SELECT CAST(gs.period AS date) AS period, COUNT(a.id) AS value
        FROM {_PERIODS}
        LEFT JOIN accounts a
          ON a.org_id = :org_id
         AND date_trunc(:unit, CAST(a.opened_at AS timestamp)) = gs.period
        GROUP BY gs.period
        ORDER BY gs.period
        """
    ),
}


@router.get("/summary", response_model=SummaryOut)
def summary(user: CurrentUser, db: Db):
    active_accounts, total_value = db.execute(
        select(func.count(Account.id), func.sum(Account.monthly_value)).where(
            Account.org_id == user.org_id, Account.status == "active"
        )
    ).one()
    now = datetime.now(UTC)
    current = net_revenue_between(db, user.org_id, now - timedelta(days=30), now)
    previous = net_revenue_between(
        db, user.org_id, now - timedelta(days=60), now - timedelta(days=30)
    )
    return SummaryOut(
        active_accounts=active_accounts,
        total_monthly_value=money(total_value),
        net_revenue_30d=current,
        net_revenue_prev_30d=previous,
        net_revenue_change_pct=pct_change(current, previous),
    )


@router.get("/timeseries", response_model=list[TimeseriesPoint])
def timeseries(
    user: CurrentUser,
    db: Db,
    metric: Literal["net_revenue", "new_accounts"],
    interval: Literal["week", "month"] = "month",
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
):
    end = to or datetime.now(UTC).date()
    start = from_ or end - timedelta(days=365)
    if start > end:
        raise ApiError(422, "validation_error", "from: must not be after to")
    if (end - start).days > MAX_RANGE_DAYS:
        raise ApiError(422, "validation_error", "from: range must be 5 years or less")

    rows = db.execute(
        TIMESERIES_SQL[metric],
        {
            "unit": interval,
            "step": STEP[interval],
            "start": start,
            "end": end,
            "org_id": user.org_id,
        },
    ).all()
    convert = money if metric == "net_revenue" else int
    return [TimeseriesPoint(period=row.period, value=convert(row.value)) for row in rows]


@router.get("/top-accounts", response_model=list[TopAccountOut])
def top_accounts(
    user: CurrentUser,
    db: Db,
    limit: Annotated[int, Query(ge=1, le=50)] = 5,
    days: Annotated[int, Query(ge=1, le=3650)] = 90,
):
    since = datetime.now(UTC) - timedelta(days=days)
    net = func.sum(signed_amount()).label("net_revenue")
    rows = db.execute(
        select(Account.id, Account.name, Account.tier, net)
        .join(
            Transaction,
            and_(Transaction.org_id == Account.org_id, Transaction.account_id == Account.id),
        )
        .where(Account.org_id == user.org_id, Transaction.occurred_at >= since)
        .group_by(Account.id, Account.name, Account.tier)
        .order_by(net.desc(), Account.name)
        .limit(limit)
    ).all()
    return [
        TopAccountOut(
            account_id=row.id, name=row.name, tier=row.tier, net_revenue=money(row.net_revenue)
        )
        for row in rows
    ]

import uuid
from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class SummaryOut(BaseModel):
    active_accounts: int
    total_monthly_value: Decimal
    net_revenue_30d: Decimal
    net_revenue_prev_30d: Decimal
    net_revenue_change_pct: float | None


class TimeseriesPoint(BaseModel):
    period: date
    value: Decimal | int


class TopAccountOut(BaseModel):
    account_id: uuid.UUID
    name: str
    tier: str
    net_revenue: Decimal

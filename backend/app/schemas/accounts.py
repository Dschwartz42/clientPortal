import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

Status = Literal["active", "paused", "closed"]
Tier = Literal["bronze", "silver", "gold"]
Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
MonthlyValue = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]


class AccountCreate(BaseModel):
    name: Name
    status: Status = "active"
    tier: Tier
    monthly_value: MonthlyValue
    owner_user_id: uuid.UUID | None = None
    opened_at: date | None = None


class AccountUpdate(BaseModel):
    name: Name | None = None
    status: Status | None = None
    tier: Tier | None = None
    monthly_value: MonthlyValue | None = None
    owner_user_id: uuid.UUID | None = None
    opened_at: date | None = None

    @model_validator(mode="after")
    def _only_owner_may_be_null(self) -> Self:
        for field in self.model_fields_set - {"owner_user_id"}:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self


class AccountOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    status: Status
    tier: Tier
    monthly_value: Decimal
    owner_user_id: uuid.UUID | None
    opened_at: date
    closed_at: date | None
    created_at: datetime


class AccountDetail(AccountOut):
    owner_name: str | None
    revenue_30d: Decimal

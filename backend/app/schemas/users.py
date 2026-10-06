import uuid
from datetime import datetime
from typing import Annotated, Literal, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints, model_validator

from app.schemas.types import reject_nul

Role = Literal["admin", "member"]
# Deliberately loose: demo tenants use the reserved .test domain, which strict
# validators such as pydantic's EmailStr reject.
Email = Annotated[
    str,
    StringConstraints(strip_whitespace=True, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$"),
    AfterValidator(reject_nul),
]
FullName = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
    AfterValidator(reject_nul),
]


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    email: str
    full_name: str
    role: Role
    is_active: bool
    last_login_at: datetime | None
    created_at: datetime


class UserInvite(BaseModel):
    email: Email
    full_name: FullName
    role: Role = "member"


class InvitedUserOut(UserOut):
    temporary_password: str


class UserUpdate(BaseModel):
    role: Role | None = None
    is_active: bool | None = None

    @model_validator(mode="after")
    def _at_least_one_real_value(self) -> Self:
        if not self.model_fields_set:
            raise ValueError("provide role or is_active")
        for field in self.model_fields_set:
            if getattr(self, field) is None:
                raise ValueError(f"{field} cannot be null")
        return self

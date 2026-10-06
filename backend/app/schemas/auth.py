import uuid

from pydantic import BaseModel, Field

from app.schemas.types import NoNulStr


class LoginIn(BaseModel):
    email: NoNulStr = Field(max_length=254)
    password: str = Field(max_length=256)


class MeOut(BaseModel):
    id: uuid.UUID
    email: str
    full_name: str
    role: str
    org_id: uuid.UUID
    org_name: str


class LoginOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: MeOut

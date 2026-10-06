import uuid
from datetime import datetime

from pydantic import BaseModel


class AuditEntryOut(BaseModel):
    id: int
    actor_user_id: uuid.UUID
    actor_name: str | None
    action: str
    entity_type: str
    entity_id: uuid.UUID
    details: dict
    created_at: datetime

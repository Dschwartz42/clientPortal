import uuid

from sqlalchemy.orm import Session

from app.models import AuditLog, User


def record(
    db: Session, actor: User, action: str, entity_type: str, entity_id: uuid.UUID, details: dict
) -> None:
    """Add an audit entry to the caller's transaction, so it commits or rolls back with the change."""
    db.add(
        AuditLog(
            org_id=actor.org_id,
            actor_user_id=actor.id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            details=details,
        )
    )

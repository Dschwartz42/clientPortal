from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import and_, func, select

from app.deps import AdminUser, Db
from app.models import AuditLog, User
from app.pagination import PageDep
from app.schemas.audit import AuditEntryOut
from app.schemas.common import Paginated
from app.schemas.types import NoNulStr

router = APIRouter(prefix="/api/audit-log", tags=["audit"])


@router.get("", response_model=Paginated[AuditEntryOut])
def list_audit_log(
    admin: AdminUser,
    db: Db,
    page: PageDep,
    action: Annotated[NoNulStr | None, Query()] = None,
):
    conditions = [AuditLog.org_id == admin.org_id]
    if action:
        conditions.append(AuditLog.action == action)

    total = db.scalar(select(func.count()).select_from(AuditLog).where(*conditions))
    rows = db.execute(
        select(AuditLog, User.full_name)
        .outerjoin(User, and_(User.org_id == AuditLog.org_id, User.id == AuditLog.actor_user_id))
        .where(*conditions)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    items = [
        AuditEntryOut(
            id=entry.id,
            actor_user_id=entry.actor_user_id,
            actor_name=actor_name,
            action=entry.action,
            entity_type=entry.entity_type,
            entity_id=entry.entity_id,
            details=entry.details,
            created_at=entry.created_at,
        )
        for entry, actor_name in rows
    ]
    return {"items": items, "total": total, "page": page.page, "page_size": page.page_size}

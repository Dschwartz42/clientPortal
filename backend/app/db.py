import uuid
from collections.abc import Iterator

from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import Session, SessionTransaction, sessionmaker

from app.config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)

_SET_TENANT = text("SELECT set_config('app.current_org_id', :org_id, true)")


@event.listens_for(SessionLocal, "after_begin")
def _reapply_tenant(session: Session, transaction: SessionTransaction, connection) -> None:
    """Re-apply the tenant at the start of each transaction of a session that has one.

    The setting is transaction-local, so a commit mid-request would otherwise reset it.
    """
    org_id = session.info.get("org_id")
    if org_id is not None:
        connection.execute(_SET_TENANT, {"org_id": org_id})


def get_db() -> Iterator[Session]:
    """One session and one transaction per request. Routes that write call db.commit()."""
    with SessionLocal() as session:
        yield session


def set_tenant(session: Session, org_id: uuid.UUID | str) -> None:
    """Scope the current transaction to one tenant.

    set_config(..., true) is transaction-local, so the value cannot leak to another
    request that reuses this pooled connection. It also takes a bound parameter,
    which SET LOCAL cannot. The org is also remembered on the session so the after_begin
    listener can re-apply it when a later transaction of the same session begins.
    """
    session.info["org_id"] = str(org_id)
    session.execute(_SET_TENANT, {"org_id": str(org_id)})

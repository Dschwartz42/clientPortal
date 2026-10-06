import uuid
from collections.abc import Iterator

from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from app.config import settings

engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, expire_on_commit=False)


def get_db() -> Iterator[Session]:
    """One session and one transaction per request. Routes that write call db.commit()."""
    with SessionLocal() as session:
        yield session


def set_tenant(session: Session, org_id: uuid.UUID | str) -> None:
    """Scope the current transaction to one tenant.

    set_config(..., true) is transaction-local, so the value cannot leak to another
    request that reuses this pooled connection. It also takes a bound parameter,
    which SET LOCAL cannot.
    """
    session.execute(
        text("SELECT set_config('app.current_org_id', :org_id, true)"), {"org_id": str(org_id)}
    )

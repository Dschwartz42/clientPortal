# Client Portal — Plan 1 of 5: Backend Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A FastAPI backend with the full schema, PostgreSQL Row-Level Security, JWT auth, and the accounts/transactions endpoints, with RLS and cross-tenant tests passing.

**Architecture:** Shared database, shared schema, `org_id` on every row. The API connects as `portal_app` (not the table owner) so RLS applies; each request runs in one transaction and sets `app.current_org_id` with `set_config(..., true)`. Application queries also filter by `org_id` (defense in depth).

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, psycopg 3, Pydantic v2, argon2-cffi, PyJWT, pytest, ruff, PostgreSQL 16 (Docker Compose).

**Spec:** `client-portal-spec.md` (repo root) — sections 3, 4, 5, 6, 9.1.

**Sequence:** Plan 1 (this) → Plan 2 (GitHub + CI) → Plan 3 (rest of API + seed) → Plan 4 (frontend) → Plan 5 (deploy + docs). Plan 1 commits straight to local `main`; from Plan 2 on, everything lands through PRs.

## Global Constraints

- Python 3.12; PostgreSQL 16. All PKs are UUID (`gen_random_uuid()`), all timestamps `timestamptz`.
- Two DB roles: `portal_owner` (owns tables, runs Alembic and the seed) and `portal_app` (the API; SELECT/INSERT/UPDATE/DELETE only).
- Every tenant table has an RLS policy on `org_id`; `organizations` matches on `id`.
- Tenant context is set with `SELECT set_config('app.current_org_id', :org_id, true)` — never string-built SQL, never session-level `SET`.
- Errors: `{ "error": { "code": "...", "message": "..." } }`. Cross-tenant access returns **404, not 403**. Validation errors: 422.
- Lists: `{ "items": [...], "total": n, "page": 1, "page_size": 25 }`; `page_size` is capped at 100.
- Money is `numeric(12,2)` in the DB and a string in JSON.
- JWT: HS256, signed with `JWT_SECRET`, claims `sub`, `org_id`, `role`, `iat`, `exp`, 60-minute expiry.
- All config from env vars via pydantic-settings. Commit `.env.example`, never `.env`.
- Tests connect as `portal_app` against `portal_test`; each test runs in a transaction that is rolled back.
- `ruff check .` and `ruff format --check .` must pass before every commit. Code blocks in this plan are not pre-formatted: run `ruff check --fix .` and `ruff format .` to settle import order and wrapping, then re-run the checks.

## Two deliberate deviations from the spec's SQL

Both are needed for the spec's own behaviour to hold. Keep them; they are good interview material.

1. **Policies use `NULLIF(current_setting('app.current_org_id', true), '')::uuid`.** Once a custom setting has been set on a connection, it reverts to an empty string (not NULL) when the transaction ends. On a pooled connection, the spec's plain `::uuid` cast would then raise `invalid input syntax for type uuid: ""` instead of returning zero rows. `NULLIF` restores "unset context returns zero rows".
2. **`users` gets `ENABLE` but not `FORCE ROW LEVEL SECURITY`.** `auth_find_user` is `SECURITY DEFINER` owned by `portal_owner`. With `FORCE`, the owner is subject to the policy too, so the function would find nobody and login could never succeed. `portal_app` is not the owner, so RLS on `users` still fully applies to the API. The other four tables keep `FORCE`.

## Review Focus

1. Account search containing `%` or `_` → treated as literal characters, not wildcards (test in Task 6).
2. `PATCH` with an explicit `null` for a required field (`{"name": null}`) → 422, not a 500 from the NOT NULL constraint (Task 6).
3. Malformed credentials — garbage bearer token, or a validly signed token whose `sub` is not a UUID → 401, not 500 (Task 5).
4. Reopening a closed account (`closed` → `active`) → `closed_at` is cleared (Task 6).
5. A pooled connection whose tenant setting is an empty string → zero rows, no error (Task 4).

---

### Task 0: Prerequisites (human, one-time)

This machine currently has Python 3.13 (not 3.12), and no Docker, `psql`, or `az`.

- [ ] **Step 1: Install tools**

```bash
brew install python@3.12
brew install --cask docker        # or OrbStack; then start it once so the daemon is running
```

- [ ] **Step 2: Verify**

Run: `python3.12 --version && docker compose version`
Expected: `Python 3.12.x` and a Docker Compose version line.

`psql` is not needed locally: every `psql` command in these plans runs inside the Postgres container.

---

### Task 1: Repo scaffold, Postgres, FastAPI skeleton, `/health`

**Files:**
- Create: `.gitignore`, `docker-compose.yml`
- Create: `backend/pyproject.toml`, `backend/.env.example`, `backend/scripts/__init__.py`, `backend/scripts/ci_db_setup.sql`
- Create: `backend/app/__init__.py`, `backend/app/config.py`, `backend/app/db.py`, `backend/app/main.py`
- Test: `backend/tests/conftest.py`, `backend/tests/integration/test_health.py`

**Interfaces:**
- Produces: `app.config.settings` (`database_url`, `migration_database_url`, `jwt_secret`, `jwt_expire_minutes`, `cors_origins`); `app.db.engine`, `app.db.SessionLocal`, `app.db.get_db() -> Iterator[Session]`, `app.db.set_tenant(session, org_id) -> None`; `app.main.app`.

- [ ] **Step 1: Initialise the repo**

```bash
cd /Users/daniel/dev/clientPortal
git init -b main
mkdir -p backend/app backend/scripts backend/tests/unit backend/tests/integration docs/wireframes
touch backend/app/__init__.py backend/scripts/__init__.py
```

`.gitignore`:

```gitignore
.env
.venv/
__pycache__/
*.pyc
.pytest_cache/
.ruff_cache/
.coverage
htmlcov/
node_modules/
dist/
.DS_Store
```

- [ ] **Step 2: Postgres with both roles and both databases**

`backend/scripts/ci_db_setup.sql` (used by Docker Compose locally and by CI — one source of truth):

```sql
CREATE ROLE portal_owner LOGIN PASSWORD 'owner_pw';
CREATE ROLE portal_app LOGIN PASSWORD 'app_pw';
CREATE DATABASE portal OWNER portal_owner;
CREATE DATABASE portal_test OWNER portal_owner;
\connect portal
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
\connect portal_test
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

`docker-compose.yml`:

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./backend/scripts/ci_db_setup.sql:/docker-entrypoint-initdb.d/01_setup.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata:
```

Run: `docker compose up -d && docker compose exec db psql -U postgres -c '\du'`
Expected: role list includes `portal_owner` and `portal_app`. (The init script only runs on an empty volume; `docker compose down -v` resets it.)

- [ ] **Step 3: Python project**

`backend/pyproject.toml`:

```toml
[project]
name = "client-portal-backend"
version = "0.1.0"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115",
  "uvicorn[standard]>=0.30",
  "sqlalchemy>=2.0.30",
  "alembic>=1.13",
  "psycopg[binary]>=3.2",
  "pydantic>=2.7",
  "pydantic-settings>=2.3",
  "argon2-cffi>=23.1",
  "pyjwt>=2.8",
]

[project.optional-dependencies]
dev = ["pytest>=8", "httpx>=0.27", "pytest-cov>=5", "ruff>=0.6", "faker>=25"]

[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[tool.setuptools.packages.find]
include = ["app*", "scripts*"]

[tool.pytest.ini_options]
testpaths = ["tests"]
pythonpath = ["."]

[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP"]
ignore = ["E501"]  # line length is the formatter's job

[tool.ruff.lint.per-file-ignores]
"tests/conftest.py" = ["E402"]
"tests/integration/conftest.py" = ["E402"]
```

`backend/.env.example`:

```dotenv
DATABASE_URL=postgresql+psycopg://portal_app:app_pw@localhost:5432/portal
MIGRATION_DATABASE_URL=postgresql+psycopg://portal_owner:owner_pw@localhost:5432/portal
JWT_SECRET=change-me-to-a-random-string-of-at-least-32-chars
CORS_ORIGINS=http://localhost:5173
```

```bash
cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
```

- [ ] **Step 4: Write the failing test**

`backend/tests/conftest.py` (environment only — forces the test database so tests can never touch `portal`):

```python
import os

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://portal_app:app_pw@localhost:5432/portal_test"
)
os.environ["MIGRATION_DATABASE_URL"] = os.environ.get(
    "TEST_MIGRATION_DATABASE_URL",
    "postgresql+psycopg://portal_owner:owner_pw@localhost:5432/portal_test",
)
os.environ["JWT_SECRET"] = "test-secret-0123456789-0123456789-0123456789"
```

`backend/tests/integration/test_health.py`:

```python
from fastapi.testclient import TestClient

from app import main
from app.main import app


def test_health_ok():
    r = TestClient(app).get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok", "db": "ok"}


def test_health_reports_db_failure(monkeypatch):
    class Broken:
        def connect(self):
            raise RuntimeError("db down")

    monkeypatch.setattr(main, "engine", Broken())
    r = TestClient(app).get("/health")
    assert r.status_code == 503
    assert r.json() == {"status": "degraded", "db": "error"}
```

- [ ] **Step 5: Run it to verify it fails**

Run: `pytest tests/integration/test_health.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.main'`.

- [ ] **Step 6: Implement**

`backend/app/config.py`:

```python
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str
    migration_database_url: str | None = None
    jwt_secret: str
    jwt_expire_minutes: int = 60
    cors_origins: str = "http://localhost:5173"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.cors_origins.split(",") if o.strip()]


settings = Settings()
```

`backend/app/db.py`:

```python
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
```

`backend/app/main.py`:

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.config import settings
from app.db import engine

app = FastAPI(title="Client Portal API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    try:
        with engine.connect() as conn:
            conn.execute(text("SELECT 1"))
    except Exception:
        return JSONResponse(status_code=503, content={"status": "degraded", "db": "error"})
    return {"status": "ok", "db": "ok"}
```

- [ ] **Step 7: Run tests, lint, commit**

Run: `pytest tests/integration/test_health.py -v && ruff check . && ruff format --check .`
Expected: 2 passed; ruff clean (run `ruff format .` if it reports files).

```bash
cd .. && git add -A && git commit -m "feat: repo scaffold, compose postgres, FastAPI skeleton with /health"
```

---

### Task 2: Password hashing and JWT

**Files:**
- Create: `backend/app/security.py`
- Test: `backend/tests/unit/test_security.py`

**Interfaces:**
- Produces: `hash_password(password: str) -> str`; `verify_password(password: str, password_hash: str) -> bool`; `create_access_token(user_id: UUID, org_id: UUID, role: str, expires_minutes: int | None = None) -> str`; `decode_access_token(token: str) -> dict` (raises `jwt.InvalidTokenError`).

- [ ] **Step 1: Write the failing tests**

`backend/tests/unit/test_security.py`:

```python
import uuid

import jwt
import pytest

from app.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    verify_password,
)


def test_hash_verifies_correct_password_and_rejects_wrong_one():
    hashed = hash_password("s3cret-pass")
    assert hashed != "s3cret-pass"
    assert verify_password("s3cret-pass", hashed) is True
    assert verify_password("wrong", hashed) is False


def test_verify_rejects_garbage_hash():
    assert verify_password("anything", "not-a-hash") is False


def test_jwt_round_trip():
    user_id, org_id = uuid.uuid4(), uuid.uuid4()
    claims = decode_access_token(create_access_token(user_id, org_id, "admin"))
    assert claims["sub"] == str(user_id)
    assert claims["org_id"] == str(org_id)
    assert claims["role"] == "admin"
    assert claims["exp"] - claims["iat"] == 60 * 60


def test_expired_token_rejected():
    token = create_access_token(uuid.uuid4(), uuid.uuid4(), "member", expires_minutes=-1)
    with pytest.raises(jwt.ExpiredSignatureError):
        decode_access_token(token)


def test_tampered_token_rejected():
    forged = jwt.encode(
        {"sub": str(uuid.uuid4()), "org_id": str(uuid.uuid4()), "role": "admin", "exp": 9999999999},
        "some-other-secret-0123456789-0123456789",
        algorithm="HS256",
    )
    with pytest.raises(jwt.InvalidSignatureError):
        decode_access_token(forged)
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/unit/test_security.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.security'`.

- [ ] **Step 3: Implement**

`backend/app/security.py`:

```python
import uuid
from datetime import UTC, datetime, timedelta

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.config import settings

ALGORITHM = "HS256"
_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def create_access_token(
    user_id: uuid.UUID, org_id: uuid.UUID, role: str, expires_minutes: int | None = None
) -> str:
    now = datetime.now(UTC)
    minutes = settings.jwt_expire_minutes if expires_minutes is None else expires_minutes
    claims = {
        "sub": str(user_id),
        "org_id": str(org_id),
        "role": role,
        "iat": now,
        "exp": now + timedelta(minutes=minutes),
    }
    return jwt.encode(claims, settings.jwt_secret, algorithm=ALGORITHM)


def decode_access_token(token: str) -> dict:
    return jwt.decode(token, settings.jwt_secret, algorithms=[ALGORITHM])
```

- [ ] **Step 4: Run, lint, commit**

Run: `pytest tests/unit/test_security.py -v && ruff check . && ruff format --check .`
Expected: 5 passed.

```bash
git add -A && git commit -m "feat: argon2 password hashing and HS256 JWT helpers"
```

---

### Task 3: Schema migration and models

**Files:**
- Create: `backend/alembic.ini`, `backend/alembic/env.py` (via `alembic init`, then replaced), `backend/alembic/versions/0001_schema.py`
- Create: `backend/app/models/__init__.py`, `base.py`, `organization.py`, `user.py`, `account.py`, `transaction.py`, `audit_log.py`

**Interfaces:**
- Produces: `app.models.{Base, Organization, User, Account, Transaction, AuditLog}` with attributes named exactly as the spec's columns.

- [ ] **Step 1: Initialise Alembic**

```bash
cd backend && alembic init alembic
```

Replace `backend/alembic/env.py` entirely:

```python
from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

from app.config import settings

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

# Migrations run as the table owner, not as the API role.
URL = settings.migration_database_url or settings.database_url


def run_migrations_offline() -> None:
    context.configure(url=URL, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(URL, poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
```

Leave the generated `alembic.ini` as is (it already has `script_location = alembic` and `prepend_sys_path = .`).

- [ ] **Step 2: Write the schema migration**

`backend/alembic/versions/0001_schema.py`:

```python
"""tables, constraints, indexes"""

from alembic import op

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

STATEMENTS = [
    """
    CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        plan text NOT NULL CHECK (plan IN ('free', 'pro', 'enterprise')),
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    """
    CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id),
        email citext NOT NULL UNIQUE,
        password_hash text NOT NULL,
        full_name text NOT NULL,
        role text NOT NULL CHECK (role IN ('admin', 'member')),
        is_active boolean NOT NULL DEFAULT true,
        last_login_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, id)
    )
    """,
    """
    CREATE TABLE accounts (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id),
        name text NOT NULL,
        status text NOT NULL CHECK (status IN ('active', 'paused', 'closed')),
        tier text NOT NULL CHECK (tier IN ('bronze', 'silver', 'gold')),
        monthly_value numeric(12,2) NOT NULL CHECK (monthly_value >= 0),
        owner_user_id uuid,
        opened_at date NOT NULL,
        closed_at date,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, id),
        FOREIGN KEY (org_id, owner_user_id) REFERENCES users (org_id, id)
    )
    """,
    """
    CREATE TABLE transactions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id),
        account_id uuid NOT NULL,
        type text NOT NULL CHECK (type IN ('charge', 'refund', 'credit')),
        amount numeric(12,2) NOT NULL CHECK (amount > 0),
        description text,
        occurred_at timestamptz NOT NULL,
        FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)
    )
    """,
    """
    CREATE TABLE audit_log (
        id bigserial PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations (id),
        actor_user_id uuid NOT NULL,
        action text NOT NULL,
        entity_type text NOT NULL,
        entity_id uuid NOT NULL,
        details jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX ix_users_org ON users (org_id)",
    "CREATE INDEX ix_accounts_org_status ON accounts (org_id, status)",
    "CREATE INDEX ix_accounts_org_name ON accounts (org_id, name)",
    "CREATE INDEX ix_transactions_org_occurred ON transactions (org_id, occurred_at DESC)",
    "CREATE INDEX ix_transactions_org_account_occurred"
    " ON transactions (org_id, account_id, occurred_at DESC)",
    "CREATE INDEX ix_audit_log_org_created ON audit_log (org_id, created_at DESC)",
]


def upgrade() -> None:
    for statement in STATEMENTS:
        op.execute(statement)


def downgrade() -> None:
    for table in ("audit_log", "transactions", "accounts", "users", "organizations"):
        op.execute(f"DROP TABLE {table}")
```

- [ ] **Step 3: Run the migration**

Run: `alembic upgrade head && docker compose exec db psql -U postgres -d portal -c '\dt'`
Expected: five tables plus `alembic_version`, all owned by `portal_owner`.

- [ ] **Step 4: Write the models**

Models only describe the tables for querying; the migration is the source of truth for DDL.

`backend/app/models/base.py`:

```python
from sqlalchemy.orm import DeclarativeBase


class Base(DeclarativeBase):
    pass
```

`backend/app/models/organization.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Organization(Base):
    __tablename__ = "organizations"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(Text)
    slug: Mapped[str] = mapped_column(Text, unique=True)
    plan: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

`backend/app/models/user.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Text, func, text
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"))
    email: Mapped[str] = mapped_column(CITEXT, unique=True)
    password_hash: Mapped[str] = mapped_column(Text)
    full_name: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(default=True, server_default=text("true"))
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

`backend/app/models/account.py`:

```python
import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Account(Base):
    __tablename__ = "accounts"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"))
    name: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text)
    tier: Mapped[str] = mapped_column(Text)
    monthly_value: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    owner_user_id: Mapped[uuid.UUID | None]
    opened_at: Mapped[date]
    closed_at: Mapped[date | None]
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

`backend/app/models/transaction.py`:

```python
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Numeric, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Transaction(Base):
    __tablename__ = "transactions"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"))
    account_id: Mapped[uuid.UUID]
    type: Mapped[str] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    description: Mapped[str | None] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
```

`backend/app/models/audit_log.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AuditLog(Base):
    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    org_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id"))
    actor_user_id: Mapped[uuid.UUID]
    action: Mapped[str] = mapped_column(Text)
    entity_type: Mapped[str] = mapped_column(Text)
    entity_id: Mapped[uuid.UUID]
    details: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
```

`backend/app/models/__init__.py`:

```python
from app.models.account import Account
from app.models.audit_log import AuditLog
from app.models.base import Base
from app.models.organization import Organization
from app.models.transaction import Transaction
from app.models.user import User

__all__ = ["Account", "AuditLog", "Base", "Organization", "Transaction", "User"]
```

- [ ] **Step 5: Verify and commit**

Run: `python -c "from app.models import Account, AuditLog, Organization, Transaction, User; print('ok')" && ruff check . && ruff format --check .`
Expected: `ok`. (Behaviour is tested in Task 4, where the fixtures insert through these models.)

```bash
git add -A && git commit -m "feat: schema migration and SQLAlchemy models"
```

---

### Task 4: Row-Level Security, test fixtures, database-level RLS tests

**Files:**
- Create: `backend/alembic/versions/0002_rls.py`
- Create: `backend/tests/integration/conftest.py`
- Test: `backend/tests/integration/test_rls.py`

**Interfaces:**
- Consumes: `app.db.{engine, get_db, set_tenant}`, `app.models.*`, `app.security.{hash_password, create_access_token}`.
- Produces (fixtures used by every later integration test):
  - `conn` — a connection as `portal_app` inside a transaction that is rolled back.
  - `db` — a `Session` on `conn`.
  - `seeded` — `Seeded(a: OrgFixture, b: OrgFixture, password: str)`; `OrgFixture(org, admin, member, accounts)`. `accounts` = `[Alpha (active, gold, 1000.00), Beta (active, silver, 500.00), Gamma (closed, bronze, 100.00)]`. Alpha has six transactions: last 30 days net **1250.00**, previous 30 days net **700.00**.
  - `client` — `TestClient` whose `get_db` uses `conn`.
  - `auth(user) -> dict` — an `Authorization` header for that user.
- Produces (SQL): function `auth_find_user(citext)`.

- [ ] **Step 1: Write the fixtures**

`backend/tests/integration/conftest.py`:

```python
import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import engine, get_db, set_tenant
from app.main import app
from app.models import Account, Organization, Transaction, User
from app.security import create_access_token, hash_password

BACKEND = Path(__file__).resolve().parents[2]
PASSWORD = "CorrectHorse1!"
PASSWORD_HASH = hash_password(PASSWORD)  # hashed once; argon2 is deliberately slow
CLEAR_TENANT = text("SELECT set_config('app.current_org_id', '', true)")


@dataclass
class OrgFixture:
    org: Organization
    admin: User
    member: User
    accounts: list[Account]


@dataclass
class Seeded:
    a: OrgFixture
    b: OrgFixture
    password: str


@pytest.fixture(scope="session", autouse=True)
def _migrate():
    cfg = Config(str(BACKEND / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND / "alembic"))
    command.upgrade(cfg, "head")


@pytest.fixture()
def conn():
    connection = engine.connect()
    transaction = connection.begin()
    try:
        yield connection
    finally:
        transaction.rollback()
        connection.close()


@pytest.fixture()
def db(conn):
    session = Session(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
    yield session
    session.close()


def _make_org(db: Session, slug: str, name: str) -> OrgFixture:
    org = Organization(id=uuid.uuid4(), name=name, slug=slug, plan="pro")
    set_tenant(db, org.id)  # fixtures insert as portal_app, so RLS applies to them too
    db.add(org)
    db.flush()
    admin = User(
        id=uuid.uuid4(), org_id=org.id, email=f"admin@{slug}.test",
        password_hash=PASSWORD_HASH, full_name=f"{name} Admin", role="admin",
    )
    member = User(
        id=uuid.uuid4(), org_id=org.id, email=f"member@{slug}.test",
        password_hash=PASSWORD_HASH, full_name=f"{name} Member", role="member",
    )
    db.add_all([admin, member])
    db.flush()
    today = date.today()
    accounts = [
        Account(
            id=uuid.uuid4(), org_id=org.id, name=f"{name} Alpha", status="active", tier="gold",
            monthly_value=Decimal("1000.00"), owner_user_id=admin.id,
            opened_at=today - timedelta(days=200),
        ),
        Account(
            id=uuid.uuid4(), org_id=org.id, name=f"{name} Beta", status="active", tier="silver",
            monthly_value=Decimal("500.00"), opened_at=today - timedelta(days=100),
        ),
        Account(
            id=uuid.uuid4(), org_id=org.id, name=f"{name} Gamma", status="closed", tier="bronze",
            monthly_value=Decimal("100.00"), opened_at=today - timedelta(days=300),
            closed_at=today - timedelta(days=20),
        ),
    ]
    db.add_all(accounts)
    db.flush()
    now = datetime.now(UTC)
    # Last 30 days: 1000 + 500 - 200 - 50 = 1250.00. Previous 30 days: 800 - 100 = 700.00.
    for type_, amount, days_ago in [
        ("charge", "1000.00", 5), ("charge", "500.00", 10), ("refund", "200.00", 12),
        ("credit", "50.00", 15), ("charge", "800.00", 40), ("refund", "100.00", 45),
    ]:
        db.add(
            Transaction(
                id=uuid.uuid4(), org_id=org.id, account_id=accounts[0].id, type=type_,
                amount=Decimal(amount), description=f"{type_} {days_ago}d ago",
                occurred_at=now - timedelta(days=days_ago),
            )
        )
    db.flush()
    return OrgFixture(org=org, admin=admin, member=member, accounts=accounts)


@pytest.fixture()
def seeded(db) -> Seeded:
    a = _make_org(db, "orga", "Org A")
    b = _make_org(db, "orgb", "Org B")
    db.execute(CLEAR_TENANT)
    return Seeded(a=a, b=b, password=PASSWORD)


@pytest.fixture()
def client(conn):
    def override_get_db():
        session = Session(
            bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False
        )
        # Every request starts with no tenant, as it would on a fresh pooled connection.
        session.execute(CLEAR_TENANT)
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()


@pytest.fixture()
def auth():
    def _headers(user: User) -> dict[str, str]:
        token = create_access_token(user.id, user.org_id, user.role)
        return {"Authorization": f"Bearer {token}"}

    return _headers
```

- [ ] **Step 2: Write the failing RLS tests**

`backend/tests/integration/test_rls.py`:

```python
"""Database-level isolation: direct SQL as portal_app, no API involved."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.db import set_tenant

TENANT_TABLES = ["users", "accounts", "transactions", "audit_log"]
INSERT_ACCOUNT = text(
    "INSERT INTO accounts (org_id, name, status, tier, monthly_value, opened_at)"
    " VALUES (:org_id, 'Intruder', 'active', 'gold', 1, CURRENT_DATE)"
)


def test_tests_run_as_the_app_role(db):
    assert db.execute(text("SELECT current_user")).scalar() == "portal_app"


def test_select_returns_only_current_org(db, seeded):
    set_tenant(db, seeded.a.org.id)
    org_ids = db.execute(text("SELECT org_id FROM accounts")).scalars().all()
    assert len(org_ids) == 3
    assert set(org_ids) == {seeded.a.org.id}
    assert db.execute(text("SELECT count(*) FROM users")).scalar() == 2
    assert db.execute(text("SELECT count(*) FROM organizations")).scalar() == 1


def test_no_org_set_returns_zero_rows(db, seeded):
    # seeded leaves the setting as '' — exactly what a reused pooled connection looks like.
    for table in [*TENANT_TABLES, "organizations"]:
        assert db.execute(text(f"SELECT count(*) FROM {table}")).scalar() == 0


def test_insert_into_other_org_rejected(db, seeded):
    set_tenant(db, seeded.a.org.id)
    with pytest.raises(DBAPIError, match="row-level security"):
        with db.begin_nested():
            db.execute(INSERT_ACCOUNT, {"org_id": seeded.b.org.id})


def test_update_cannot_move_row_to_other_org(db, seeded):
    set_tenant(db, seeded.a.org.id)
    with pytest.raises(DBAPIError, match="row-level security"):
        with db.begin_nested():
            db.execute(
                text("UPDATE accounts SET org_id = :b WHERE id = :id"),
                {"b": seeded.b.org.id, "id": seeded.a.accounts[1].id},
            )


def test_update_and_delete_cannot_touch_other_org(db, seeded):
    set_tenant(db, seeded.a.org.id)
    target = {"id": seeded.b.accounts[1].id}
    updated = db.execute(text("UPDATE accounts SET name = 'pwned' WHERE id = :id"), target)
    deleted = db.execute(text("DELETE FROM accounts WHERE id = :id"), target)
    assert updated.rowcount == 0
    assert deleted.rowcount == 0


def test_transaction_cannot_reference_other_orgs_account(db, seeded):
    set_tenant(db, seeded.a.org.id)
    with pytest.raises(IntegrityError, match="foreign key"):
        with db.begin_nested():
            db.execute(
                text(
                    "INSERT INTO transactions (org_id, account_id, type, amount, occurred_at)"
                    " VALUES (:org_id, :account_id, 'charge', 10, now())"
                ),
                {"org_id": seeded.a.org.id, "account_id": seeded.b.accounts[0].id},
            )


def test_auth_find_user_works_without_tenant_context(db, seeded):
    assert db.execute(text("SELECT count(*) FROM users")).scalar() == 0
    row = db.execute(
        text("SELECT org_id, role FROM auth_find_user(CAST(:email AS citext))"),
        {"email": "ADMIN@orga.test"},
    ).one()
    assert row.org_id == seeded.a.org.id
    assert row.role == "admin"
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/integration/test_rls.py -v`
Expected: every test errors in the `seeded` fixture or `db` with `permission denied for table organizations` — `portal_app` has no grants yet.

- [ ] **Step 4: Write the RLS migration**

`backend/alembic/versions/0002_rls.py`:

```python
"""row-level security, app role grants, login lookup function"""

from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

# NULLIF: after a transaction that used set_config(..., true) ends, the setting reads back
# as '' rather than NULL. Without NULLIF the uuid cast would raise instead of matching nothing.
CURRENT_ORG = "NULLIF(current_setting('app.current_org_id', true), '')::uuid"

# users is ENABLEd but not FORCEd: auth_find_user is SECURITY DEFINER owned by the table
# owner and must be able to read users before any tenant is known.
FORCED = {"organizations", "accounts", "transactions", "audit_log"}
TENANT_COLUMN = {
    "organizations": "id",
    "users": "org_id",
    "accounts": "org_id",
    "transactions": "org_id",
    "audit_log": "org_id",
}


def upgrade() -> None:
    for table, column in TENANT_COLUMN.items():
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        if table in FORCED:
            op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table}"
            f" USING ({column} = {CURRENT_ORG}) WITH CHECK ({column} = {CURRENT_ORG})"
        )

    op.execute(
        """
        CREATE FUNCTION auth_find_user(p_email citext)
        RETURNS TABLE (id uuid, org_id uuid, password_hash text, role text, is_active boolean)
        LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
            SELECT u.id, u.org_id, u.password_hash, u.role, u.is_active
            FROM users u WHERE u.email = p_email;
        $$
        """
    )
    op.execute("REVOKE ALL ON FUNCTION auth_find_user(citext) FROM PUBLIC")
    op.execute("GRANT EXECUTE ON FUNCTION auth_find_user(citext) TO portal_app")

    op.execute("GRANT USAGE ON SCHEMA public TO portal_app")
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON"
        " organizations, users, accounts, transactions, audit_log TO portal_app"
    )
    op.execute("GRANT USAGE, SELECT ON SEQUENCE audit_log_id_seq TO portal_app")


def downgrade() -> None:
    op.execute("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM portal_app")
    op.execute("REVOKE ALL ON SEQUENCE audit_log_id_seq FROM portal_app")
    op.execute("DROP FUNCTION auth_find_user(citext)")
    for table in TENANT_COLUMN:
        op.execute(f"DROP POLICY tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
```

- [ ] **Step 5: Run tests, migrate the dev database, commit**

Run: `pytest tests/integration/test_rls.py -v` (the session fixture applies `0002` to `portal_test`)
Expected: 8 passed.

Run: `alembic upgrade head && ruff check . && ruff format --check .`
Expected: `portal` is at `0002`; ruff clean.

```bash
git add -A && git commit -m "feat: row-level security policies, app role grants, RLS tests"
```

---

### Task 5: Error format, auth dependencies, login, `/me`

**Files:**
- Create: `backend/app/errors.py`, `backend/app/deps.py`, `backend/app/schemas/__init__.py` (empty), `backend/app/schemas/auth.py`, `backend/app/routers/__init__.py` (empty), `backend/app/routers/auth.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/integration/test_auth.py`

**Interfaces:**
- Consumes: `app.security.*`, `app.db.{get_db, set_tenant}`, SQL `auth_find_user`.
- Produces: `app.errors.ApiError(status_code: int, code: str, message: str)`; `app.errors.register_error_handlers(app)`; `app.deps.Db`, `app.deps.CurrentUser`, `app.deps.AdminUser` (`Annotated` dependency aliases — `CurrentUser` yields a `User` and has already called `set_tenant` on the request's session); `app.schemas.auth.MeOut`.

- [ ] **Step 1: Write the failing tests**

`backend/tests/integration/test_auth.py`:

```python
import uuid

import jwt

from app.config import settings
from app.db import set_tenant


def _login(client, email, password):
    return client.post("/api/auth/login", json={"email": email, "password": password})


def _deactivate(db, user):
    set_tenant(db, user.org_id)
    user.is_active = False
    db.flush()


def test_login_success_returns_token_and_user(client, seeded):
    r = _login(client, "admin@orga.test", seeded.password)
    assert r.status_code == 200
    body = r.json()
    assert body["access_token"]
    assert body["user"]["email"] == "admin@orga.test"
    assert body["user"]["role"] == "admin"
    assert body["user"]["org_name"] == "Org A"


def test_login_is_case_insensitive_on_email(client, seeded):
    assert _login(client, " Admin@OrgA.test ", seeded.password).status_code == 200


def test_wrong_password_and_unknown_email_are_indistinguishable(client, seeded):
    wrong = _login(client, "admin@orga.test", "nope")
    unknown = _login(client, "nobody@nowhere.test", "nope")
    assert wrong.status_code == unknown.status_code == 401
    assert wrong.json() == unknown.json()
    assert wrong.json()["error"]["code"] == "invalid_credentials"


def test_inactive_user_cannot_log_in(client, db, seeded):
    _deactivate(db, seeded.a.member)
    assert _login(client, "member@orga.test", seeded.password).status_code == 401


def test_login_token_works_on_me(client, seeded):
    token = _login(client, "member@orgb.test", seeded.password).json()["access_token"]
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200
    assert r.json()["org_name"] == "Org B"
    assert r.json()["role"] == "member"


def test_no_token_is_401(client, seeded):
    r = client.get("/api/auth/me")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "not_authenticated"


def test_garbage_token_is_401(client, seeded):
    r = client.get("/api/auth/me", headers={"Authorization": "Bearer not.a.jwt"})
    assert r.status_code == 401


def test_signed_token_with_non_uuid_subject_is_401(client, seeded):
    token = jwt.encode(
        {"sub": "42", "org_id": "nope", "role": "admin", "exp": 9999999999},
        settings.jwt_secret,
        algorithm="HS256",
    )
    r = client.get("/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 401


def test_token_for_unknown_user_is_401(client, seeded, auth):
    ghost = type(seeded.a.admin)(id=uuid.uuid4(), org_id=seeded.a.org.id, role="admin")
    assert client.get("/api/auth/me", headers=auth(ghost)).status_code == 401


def test_deactivated_users_existing_token_is_401(client, db, seeded, auth):
    headers = auth(seeded.a.member)
    assert client.get("/api/auth/me", headers=headers).status_code == 200
    _deactivate(db, seeded.a.member)
    assert client.get("/api/auth/me", headers=headers).status_code == 401


def test_validation_error_uses_error_envelope(client):
    r = client.post("/api/auth/login", json={"email": "a@b.test"})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "validation_error"


def test_unknown_route_uses_error_envelope(client):
    r = client.get("/api/nope")
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/integration/test_auth.py -v`
Expected: FAIL — 404s from the missing routes and missing `error` key.

- [ ] **Step 3: Implement errors and dependencies**

`backend/app/errors.py`:

```python
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

HTTP_CODES = {404: "not_found", 405: "method_not_allowed"}


class ApiError(Exception):
    def __init__(self, status_code: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _envelope(status_code: int, code: str, message: str) -> JSONResponse:
    return JSONResponse(
        status_code=status_code, content={"error": {"code": code, "message": message}}
    )


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api_error(request: Request, exc: ApiError) -> JSONResponse:
        return _envelope(exc.status_code, exc.code, exc.message)

    @app.exception_handler(RequestValidationError)
    async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first["loc"])
        return _envelope(422, "validation_error", f"{location}: {first['msg']}")

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(request: Request, exc: StarletteHTTPException) -> JSONResponse:
        code = HTTP_CODES.get(exc.status_code, "http_error")
        return _envelope(exc.status_code, code, str(exc.detail))
```

`backend/app/deps.py`:

```python
import uuid
from typing import Annotated

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db, set_tenant
from app.errors import ApiError
from app.models import User
from app.security import decode_access_token

_bearer = HTTPBearer(auto_error=False)

Db = Annotated[Session, Depends(get_db)]


def get_current_user(
    db: Db, credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]
) -> User:
    """Authenticate, then scope this request's transaction to the user's tenant."""
    if credentials is None:
        raise ApiError(401, "not_authenticated", "Authentication required")
    try:
        claims = decode_access_token(credentials.credentials)
        user_id = uuid.UUID(claims["sub"])
        org_id = uuid.UUID(claims["org_id"])
    except (jwt.InvalidTokenError, KeyError, ValueError):
        raise ApiError(401, "invalid_token", "Invalid or expired token") from None

    set_tenant(db, org_id)
    # Loaded on every request, so deactivation and role changes apply immediately.
    user = db.scalar(select(User).where(User.id == user_id, User.org_id == org_id))
    if user is None or not user.is_active:
        raise ApiError(401, "invalid_token", "Invalid or expired token")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_admin(user: CurrentUser) -> User:
    if user.role != "admin":
        raise ApiError(403, "forbidden", "Admin role required")
    return user


AdminUser = Annotated[User, Depends(require_admin)]
```

- [ ] **Step 4: Implement the auth router**

`backend/app/schemas/auth.py`:

```python
import uuid

from pydantic import BaseModel, Field


class LoginIn(BaseModel):
    email: str = Field(max_length=254)
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
```

`backend/app/routers/auth.py`:

```python
from datetime import UTC, datetime

from fastapi import APIRouter
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.db import set_tenant
from app.deps import CurrentUser, Db
from app.errors import ApiError
from app.models import Organization, User
from app.schemas.auth import LoginIn, LoginOut, MeOut
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Verified against when the email is unknown, so both failure paths cost one argon2 verify.
_DUMMY_HASH = hash_password("dummy-password-for-timing")
_FIND_USER = text(
    "SELECT id, org_id, password_hash, is_active FROM auth_find_user(CAST(:email AS citext))"
)


def _me(db: Session, user: User) -> MeOut:
    org_name = db.scalar(select(Organization.name).where(Organization.id == user.org_id))
    return MeOut(
        id=user.id, email=user.email, full_name=user.full_name, role=user.role,
        org_id=user.org_id, org_name=org_name,
    )


@router.post("/login", response_model=LoginOut)
def login(body: LoginIn, db: Db) -> LoginOut:
    row = db.execute(_FIND_USER, {"email": body.email.strip()}).first()
    password_ok = verify_password(body.password, row.password_hash if row else _DUMMY_HASH)
    if row is None or not password_ok or not row.is_active:
        raise ApiError(401, "invalid_credentials", "Invalid email or password")

    set_tenant(db, row.org_id)
    user = db.scalar(select(User).where(User.id == row.id, User.org_id == row.org_id))
    user.last_login_at = datetime.now(UTC)
    out = LoginOut(
        access_token=create_access_token(user.id, user.org_id, user.role), user=_me(db, user)
    )
    db.commit()
    return out


@router.get("/me", response_model=MeOut)
def me(user: CurrentUser, db: Db) -> MeOut:
    return _me(db, user)
```

In `backend/app/main.py`, add the imports and, after the CORS middleware:

```python
from app.errors import register_error_handlers
from app.routers import auth

register_error_handlers(app)
app.include_router(auth.router)
```

- [ ] **Step 5: Run, lint, commit**

Run: `pytest -v && ruff check . && ruff format --check .`
Expected: all tests pass (12 new).

```bash
git add -A && git commit -m "feat: login, /me, auth dependencies, error envelope"
```

---

### Task 6: Accounts endpoints, audit service, revenue helpers

**Files:**
- Create: `backend/app/pagination.py`, `backend/app/schemas/common.py`, `backend/app/schemas/accounts.py`
- Create: `backend/app/services/__init__.py` (empty), `backend/app/services/audit.py`, `backend/app/services/analytics.py`
- Create: `backend/app/routers/accounts.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/unit/test_analytics_math.py`, `backend/tests/integration/test_accounts.py`

**Interfaces:**
- Consumes: `Db`, `CurrentUser`, `AdminUser`, `ApiError`, models.
- Produces:
  - `app.pagination.Page(page: int, page_size: int)` with `.offset`; `app.pagination.PageDep`.
  - `app.schemas.common.Paginated[T]` (`items`, `total`, `page`, `page_size`).
  - `app.services.audit.record(db, actor: User, action: str, entity_type: str, entity_id: UUID, details: dict) -> None`.
  - `app.services.analytics.money(value) -> Decimal`; `net_revenue(items: Iterable[tuple[str, Decimal]]) -> Decimal`; `pct_change(current: Decimal, previous: Decimal) -> float | None`; `signed_amount()` (SQL expression); `net_revenue_between(db, org_id, start: datetime, end: datetime, account_id: UUID | None = None) -> Decimal`.
  - `app.routers.accounts.get_account_or_404(db, user, account_id) -> Account`.

- [ ] **Step 1: Write the failing unit test**

`backend/tests/unit/test_analytics_math.py`:

```python
from decimal import Decimal

from app.services.analytics import money, net_revenue, pct_change


def test_net_revenue_is_charges_minus_refunds_minus_credits():
    items = [
        ("charge", Decimal("1000.00")),
        ("charge", Decimal("500.00")),
        ("refund", Decimal("200.00")),
        ("credit", Decimal("50.00")),
    ]
    assert net_revenue(items) == Decimal("1250.00")


def test_net_revenue_of_nothing_is_zero():
    assert net_revenue([]) == Decimal("0.00")


def test_pct_change():
    assert pct_change(Decimal("1250.00"), Decimal("700.00")) == 78.57
    assert pct_change(Decimal("50.00"), Decimal("100.00")) == -50.0


def test_pct_change_is_none_when_there_is_no_previous_revenue():
    assert pct_change(Decimal("100.00"), Decimal("0.00")) is None


def test_money_always_has_two_decimal_places():
    assert str(money(None)) == "0.00"
    assert str(money(5)) == "5.00"
```

- [ ] **Step 2: Write the failing integration tests**

`backend/tests/integration/test_accounts.py`:

```python
import uuid
from datetime import date

from sqlalchemy import text

from app.db import set_tenant

NEW_ACCOUNT = {"name": "New Client", "tier": "silver", "monthly_value": "250.00"}


def _row(db, org_id, account_id):
    set_tenant(db, org_id)
    return db.execute(
        text("SELECT org_id, name, status, closed_at FROM accounts WHERE id = :id"),
        {"id": account_id},
    ).first()


def test_list_requires_token(client, seeded):
    assert client.get("/api/accounts").status_code == 401


def test_list_returns_only_own_org(client, seeded, auth):
    r = client.get("/api/accounts", headers=auth(seeded.a.member))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 3
    assert body["page"] == 1 and body["page_size"] == 25
    assert {a["name"] for a in body["items"]} == {"Org A Alpha", "Org A Beta", "Org A Gamma"}
    assert body["items"][0]["monthly_value"] == "1000.00"  # money is a string


def test_list_filters_search_and_sort(client, seeded, auth):
    headers = auth(seeded.a.member)
    active = client.get("/api/accounts?status=active", headers=headers).json()
    assert active["total"] == 2
    gold = client.get("/api/accounts?tier=gold", headers=headers).json()
    assert [a["name"] for a in gold["items"]] == ["Org A Alpha"]
    found = client.get("/api/accounts?search=bet", headers=headers).json()
    assert [a["name"] for a in found["items"]] == ["Org A Beta"]
    by_value = client.get("/api/accounts?sort=-monthly_value", headers=headers).json()
    assert [a["monthly_value"] for a in by_value["items"]] == ["1000.00", "500.00", "100.00"]


def test_search_treats_wildcards_literally(client, seeded, auth):
    headers = auth(seeded.a.member)
    assert client.get("/api/accounts?search=%25", headers=headers).json()["total"] == 0
    assert client.get("/api/accounts?search=_", headers=headers).json()["total"] == 0


def test_unknown_sort_field_is_422(client, seeded, auth):
    r = client.get("/api/accounts?sort=password_hash", headers=auth(seeded.a.member))
    assert r.status_code == 422


def test_pagination_total_and_page_size_cap(client, seeded, auth):
    headers = auth(seeded.a.member)
    page2 = client.get("/api/accounts?page=2&page_size=2", headers=headers).json()
    assert page2["total"] == 3 and len(page2["items"]) == 1
    capped = client.get("/api/accounts?page_size=500", headers=headers).json()
    assert capped["page_size"] == 100
    beyond = client.get("/api/accounts?page=99", headers=headers).json()
    assert beyond["items"] == [] and beyond["total"] == 3


def test_get_detail_includes_owner_and_30d_revenue(client, seeded, auth):
    alpha = seeded.a.accounts[0]
    r = client.get(f"/api/accounts/{alpha.id}", headers=auth(seeded.a.member))
    assert r.status_code == 200
    assert r.json()["owner_name"] == "Org A Admin"
    assert r.json()["revenue_30d"] == "1250.00"


def test_get_other_orgs_account_is_404(client, seeded, auth):
    r = client.get(f"/api/accounts/{seeded.b.accounts[0].id}", headers=auth(seeded.a.admin))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "not_found"


def test_patch_other_orgs_account_is_404_and_row_unchanged(client, db, seeded, auth):
    target = seeded.b.accounts[0]
    r = client.patch(
        f"/api/accounts/{target.id}", json={"name": "Hijacked"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 404
    assert _row(db, seeded.b.org.id, target.id).name == "Org B Alpha"


def test_delete_other_orgs_account_is_404(client, db, seeded, auth):
    target = seeded.b.accounts[1]
    r = client.delete(f"/api/accounts/{target.id}", headers=auth(seeded.a.admin))
    assert r.status_code == 404
    assert _row(db, seeded.b.org.id, target.id) is not None


def test_create_uses_callers_org_even_if_body_sends_another(client, db, seeded, auth):
    body = {**NEW_ACCOUNT, "org_id": str(seeded.b.org.id)}
    r = client.post("/api/accounts", json=body, headers=auth(seeded.a.admin))
    assert r.status_code == 201
    created = r.json()
    assert created["status"] == "active"
    assert created["opened_at"] == date.today().isoformat()
    assert _row(db, seeded.a.org.id, created["id"]).org_id == seeded.a.org.id
    assert _row(db, seeded.b.org.id, created["id"]) is None


def test_create_writes_audit_log(client, db, seeded, auth):
    created = client.post("/api/accounts", json=NEW_ACCOUNT, headers=auth(seeded.a.admin)).json()
    set_tenant(db, seeded.a.org.id)
    entry = db.execute(
        text("SELECT action, actor_user_id FROM audit_log WHERE entity_id = :id"),
        {"id": created["id"]},
    ).one()
    assert entry.action == "account.created"
    assert entry.actor_user_id == seeded.a.admin.id


def test_member_cannot_create(client, seeded, auth):
    r = client.post("/api/accounts", json=NEW_ACCOUNT, headers=auth(seeded.a.member))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "forbidden"


def test_create_rejects_owner_from_another_org(client, seeded, auth):
    body = {**NEW_ACCOUNT, "owner_user_id": str(seeded.b.admin.id)}
    r = client.post("/api/accounts", json=body, headers=auth(seeded.a.admin))
    assert r.status_code == 422


def test_create_rejects_negative_value_and_blank_name(client, seeded, auth):
    headers = auth(seeded.a.admin)
    negative = {**NEW_ACCOUNT, "monthly_value": "-1"}
    blank = {**NEW_ACCOUNT, "name": "   "}
    assert client.post("/api/accounts", json=negative, headers=headers).status_code == 422
    assert client.post("/api/accounts", json=blank, headers=headers).status_code == 422


def test_patch_closing_sets_closed_at_and_audits_before_after(client, db, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.patch(
        f"/api/accounts/{beta.id}", json={"status": "closed"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 200
    assert r.json()["closed_at"] == date.today().isoformat()
    set_tenant(db, seeded.a.org.id)
    details = db.execute(
        text("SELECT details FROM audit_log WHERE entity_id = :id AND action = 'account.updated'"),
        {"id": beta.id},
    ).scalar_one()
    assert details["before"]["status"] == "active"
    assert details["after"]["status"] == "closed"


def test_patch_reopening_clears_closed_at(client, seeded, auth):
    gamma = seeded.a.accounts[2]
    r = client.patch(
        f"/api/accounts/{gamma.id}", json={"status": "active"}, headers=auth(seeded.a.admin)
    )
    assert r.status_code == 200
    assert r.json()["closed_at"] is None


def test_patch_explicit_null_for_required_field_is_422(client, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.patch(f"/api/accounts/{beta.id}", json={"name": None}, headers=auth(seeded.a.admin))
    assert r.status_code == 422


def test_member_cannot_patch(client, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.patch(f"/api/accounts/{beta.id}", json={"name": "X"}, headers=auth(seeded.a.member))
    assert r.status_code == 403


def test_delete_account_with_transactions_is_409(client, seeded, auth):
    alpha = seeded.a.accounts[0]
    r = client.delete(f"/api/accounts/{alpha.id}", headers=auth(seeded.a.admin))
    assert r.status_code == 409
    assert "Close it instead" in r.json()["error"]["message"]


def test_delete_account_without_transactions(client, db, seeded, auth):
    beta = seeded.a.accounts[1]
    r = client.delete(f"/api/accounts/{beta.id}", headers=auth(seeded.a.admin))
    assert r.status_code == 204
    assert _row(db, seeded.a.org.id, beta.id) is None


def test_get_unknown_account_is_404(client, seeded, auth):
    r = client.get(f"/api/accounts/{uuid.uuid4()}", headers=auth(seeded.a.admin))
    assert r.status_code == 404
```

- [ ] **Step 3: Run to verify failure**

Run: `pytest tests/unit/test_analytics_math.py tests/integration/test_accounts.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services'` and 404s.

- [ ] **Step 4: Implement shared pieces**

`backend/app/pagination.py`:

```python
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, Query

MAX_PAGE_SIZE = 100


@dataclass
class Page:
    page: int
    page_size: int

    @property
    def offset(self) -> int:
        return (self.page - 1) * self.page_size


def page_params(
    page: Annotated[int, Query(ge=1)] = 1, page_size: Annotated[int, Query(ge=1)] = 25
) -> Page:
    return Page(page=page, page_size=min(page_size, MAX_PAGE_SIZE))


PageDep = Annotated[Page, Depends(page_params)]
```

`backend/app/schemas/common.py`:

```python
from pydantic import BaseModel


class Paginated[T](BaseModel):
    items: list[T]
    total: int
    page: int
    page_size: int
```

`backend/app/services/audit.py`:

```python
import uuid

from sqlalchemy.orm import Session

from app.models import AuditLog, User


def record(
    db: Session, actor: User, action: str, entity_type: str, entity_id: uuid.UUID, details: dict
) -> None:
    """Add an audit entry to the caller's transaction, so it commits or rolls back with the change."""
    db.add(
        AuditLog(
            org_id=actor.org_id, actor_user_id=actor.id, action=action,
            entity_type=entity_type, entity_id=entity_id, details=details,
        )
    )
```

`backend/app/services/analytics.py`:

```python
import uuid
from collections.abc import Iterable
from datetime import datetime
from decimal import Decimal

from sqlalchemy import case, func, select
from sqlalchemy.orm import Session

from app.models import Transaction

CENTS = Decimal("0.01")


def money(value: Decimal | int | None) -> Decimal:
    return Decimal(value or 0).quantize(CENTS)


def net_revenue(items: Iterable[tuple[str, Decimal]]) -> Decimal:
    """Net revenue = charges - refunds - credits. Amounts are always positive; type sets the sign."""
    total = sum((amount if type_ == "charge" else -amount for type_, amount in items), Decimal(0))
    return money(total)


def pct_change(current: Decimal, previous: Decimal) -> float | None:
    if previous == 0:
        return None
    return round(float((current - previous) / abs(previous) * 100), 2)


def signed_amount():
    """SQL form of net_revenue's sign rule."""
    return case((Transaction.type == "charge", Transaction.amount), else_=-Transaction.amount)


def net_revenue_between(
    db: Session,
    org_id: uuid.UUID,
    start: datetime,
    end: datetime,
    account_id: uuid.UUID | None = None,
) -> Decimal:
    stmt = select(func.sum(signed_amount())).where(
        Transaction.org_id == org_id,
        Transaction.occurred_at >= start,
        Transaction.occurred_at < end,
    )
    if account_id is not None:
        stmt = stmt.where(Transaction.account_id == account_id)
    return money(db.scalar(stmt))
```

- [ ] **Step 5: Implement account schemas and router**

`backend/app/schemas/accounts.py`:

```python
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
```

`backend/app/routers/accounts.py`:

```python
import uuid
from datetime import UTC, date, datetime, timedelta

from fastapi import APIRouter, Response
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session

from app.deps import AdminUser, CurrentUser, Db
from app.errors import ApiError
from app.models import Account, Transaction, User
from app.pagination import PageDep
from app.schemas.accounts import (
    AccountCreate,
    AccountDetail,
    AccountOut,
    AccountUpdate,
    Status,
    Tier,
)
from app.schemas.common import Paginated
from app.services import audit
from app.services.analytics import net_revenue_between

router = APIRouter(prefix="/api/accounts", tags=["accounts"])

SORTABLE = {
    "name": Account.name,
    "monthly_value": Account.monthly_value,
    "opened_at": Account.opened_at,
    "created_at": Account.created_at,
    "status": Account.status,
    "tier": Account.tier,
}
AUDITED = ("name", "status", "tier", "monthly_value", "owner_user_id", "opened_at", "closed_at")


def get_account_or_404(db: Session, user: User, account_id: uuid.UUID) -> Account:
    # The explicit org_id filter is defense in depth; RLS would hide the row anyway.
    account = db.scalar(
        select(Account).where(Account.id == account_id, Account.org_id == user.org_id)
    )
    if account is None:
        raise ApiError(404, "not_found", "Account not found")
    return account


def _check_owner(db: Session, user: User, owner_user_id: uuid.UUID | None) -> None:
    if owner_user_id is None:
        return
    found = db.scalar(
        select(User.id).where(User.id == owner_user_id, User.org_id == user.org_id)
    )
    if found is None:
        raise ApiError(422, "validation_error", "owner_user_id: no such user in this organization")


def _snapshot(account: Account, fields=AUDITED) -> dict:
    return {
        field: None if getattr(account, field) is None else str(getattr(account, field))
        for field in fields
    }


def _escape_like(term: str) -> str:
    return term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=Paginated[AccountOut])
def list_accounts(
    user: CurrentUser,
    db: Db,
    page: PageDep,
    status: Status | None = None,
    tier: Tier | None = None,
    search: str | None = None,
    sort: str = "name",
):
    column = SORTABLE.get(sort.removeprefix("-"))
    if column is None:
        raise ApiError(422, "validation_error", f"sort: unsupported field '{sort}'")
    conditions = [Account.org_id == user.org_id]
    if status:
        conditions.append(Account.status == status)
    if tier:
        conditions.append(Account.tier == tier)
    if search and search.strip():
        pattern = f"%{_escape_like(search.strip())}%"
        conditions.append(Account.name.ilike(pattern, escape="\\"))

    total = db.scalar(select(func.count()).select_from(Account).where(*conditions))
    order = column.desc() if sort.startswith("-") else column.asc()
    rows = db.scalars(
        select(Account)
        .where(*conditions)
        .order_by(order, Account.id)
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    return {"items": rows, "total": total, "page": page.page, "page_size": page.page_size}


@router.post("", response_model=AccountOut, status_code=201)
def create_account(body: AccountCreate, admin: AdminUser, db: Db):
    _check_owner(db, admin, body.owner_user_id)
    today = date.today()
    account = Account(
        id=uuid.uuid4(),
        org_id=admin.org_id,  # always the caller's org; the body has no org_id field
        name=body.name,
        status=body.status,
        tier=body.tier,
        monthly_value=body.monthly_value,
        owner_user_id=body.owner_user_id,
        opened_at=body.opened_at or today,
        closed_at=today if body.status == "closed" else None,
    )
    db.add(account)
    db.flush()
    db.refresh(account)
    audit.record(db, admin, "account.created", "account", account.id, {"after": _snapshot(account)})
    out = AccountOut.model_validate(account)
    db.commit()
    return out


@router.get("/{account_id}", response_model=AccountDetail)
def get_account(account_id: uuid.UUID, user: CurrentUser, db: Db):
    account = get_account_or_404(db, user, account_id)
    owner_name = None
    if account.owner_user_id is not None:
        owner_name = db.scalar(
            select(User.full_name).where(
                User.id == account.owner_user_id, User.org_id == user.org_id
            )
        )
    now = datetime.now(UTC)
    revenue = net_revenue_between(db, user.org_id, now - timedelta(days=30), now, account.id)
    return AccountDetail(
        **AccountOut.model_validate(account).model_dump(),
        owner_name=owner_name,
        revenue_30d=revenue,
    )


@router.patch("/{account_id}", response_model=AccountOut)
def update_account(account_id: uuid.UUID, body: AccountUpdate, admin: AdminUser, db: Db):
    account = get_account_or_404(db, admin, account_id)
    changes = body.model_dump(exclude_unset=True)
    if "owner_user_id" in changes:
        _check_owner(db, admin, changes["owner_user_id"])

    before = _snapshot(account)
    for field, value in changes.items():
        setattr(account, field, value)
    if "status" in changes and str(changes["status"]) != before["status"]:
        account.closed_at = date.today() if changes["status"] == "closed" else None
    after = _snapshot(account)

    changed = [field for field in AUDITED if before[field] != after[field]]
    if changed:
        audit.record(
            db, admin, "account.updated", "account", account.id,
            {
                "before": {field: before[field] for field in changed},
                "after": {field: after[field] for field in changed},
            },
        )
    db.flush()
    out = AccountOut.model_validate(account)
    db.commit()
    return out


@router.delete("/{account_id}", status_code=204)
def delete_account(account_id: uuid.UUID, admin: AdminUser, db: Db):
    account = get_account_or_404(db, admin, account_id)
    has_transactions = db.scalar(
        select(
            exists().where(
                Transaction.org_id == admin.org_id, Transaction.account_id == account.id
            )
        )
    )
    if has_transactions:
        raise ApiError(
            409, "account_has_transactions",
            "This account has transactions and cannot be deleted. Close it instead.",
        )
    audit.record(db, admin, "account.deleted", "account", account.id, {"before": _snapshot(account)})
    db.delete(account)
    db.commit()
    return Response(status_code=204)
```

In `backend/app/main.py`: change the router import to `from app.routers import accounts, auth` and add `app.include_router(accounts.router)`.

- [ ] **Step 6: Run, lint, commit**

Run: `pytest -v && ruff check . && ruff format --check .`
Expected: all pass (5 unit + 22 integration new).

```bash
git add -A && git commit -m "feat: accounts CRUD with audit logging and tenant isolation tests"
```

---

### Task 7: Account transactions endpoint

**Files:**
- Create: `backend/app/schemas/transactions.py`, `backend/app/routers/transactions.py`
- Modify: `backend/app/main.py`
- Test: `backend/tests/integration/test_transactions.py`

**Interfaces:**
- Consumes: `get_account_or_404`, `PageDep`, `Paginated`, `CurrentUser`, `Db`.
- Produces: `GET /api/accounts/{id}/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD&page=&page_size=` — both dates inclusive, interpreted in UTC.

- [ ] **Step 1: Write the failing tests**

`backend/tests/integration/test_transactions.py`:

```python
from datetime import date, timedelta


def _url(account):
    return f"/api/accounts/{account.id}/transactions"


def test_lists_newest_first_with_string_amounts(client, seeded, auth):
    r = client.get(_url(seeded.a.accounts[0]), headers=auth(seeded.a.member))
    assert r.status_code == 200
    body = r.json()
    assert body["total"] == 6
    times = [t["occurred_at"] for t in body["items"]]
    assert times == sorted(times, reverse=True)
    assert body["items"][0] == {
        "id": body["items"][0]["id"],
        "account_id": str(seeded.a.accounts[0].id),
        "type": "charge",
        "amount": "1000.00",
        "description": "charge 5d ago",
        "occurred_at": body["items"][0]["occurred_at"],
    }


def test_from_and_to_filter_inclusively(client, seeded, auth):
    today = date.today()
    params = {"from": str(today - timedelta(days=13)), "to": str(today - timedelta(days=9))}
    r = client.get(_url(seeded.a.accounts[0]), params=params, headers=auth(seeded.a.member))
    assert sorted(t["amount"] for t in r.json()["items"]) == ["200.00", "500.00"]


def test_pagination(client, seeded, auth):
    r = client.get(
        _url(seeded.a.accounts[0]), params={"page": 2, "page_size": 4},
        headers=auth(seeded.a.member),
    )
    assert r.json()["total"] == 6 and len(r.json()["items"]) == 2


def test_account_without_transactions_returns_empty_list(client, seeded, auth):
    r = client.get(_url(seeded.a.accounts[1]), headers=auth(seeded.a.member))
    assert r.json()["items"] == [] and r.json()["total"] == 0


def test_other_orgs_account_is_404(client, seeded, auth):
    r = client.get(_url(seeded.b.accounts[0]), headers=auth(seeded.a.admin))
    assert r.status_code == 404


def test_bad_date_is_422(client, seeded, auth):
    r = client.get(
        _url(seeded.a.accounts[0]), params={"from": "yesterday"}, headers=auth(seeded.a.member)
    )
    assert r.status_code == 422
```

- [ ] **Step 2: Run to verify failure**

Run: `pytest tests/integration/test_transactions.py -v`
Expected: FAIL — 404 for every request (route missing).

- [ ] **Step 3: Implement**

`backend/app/schemas/transactions.py`:

```python
import uuid
from datetime import datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, ConfigDict


class TransactionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    account_id: uuid.UUID
    type: Literal["charge", "refund", "credit"]
    amount: Decimal
    description: str | None
    occurred_at: datetime
```

`backend/app/routers/transactions.py`:

```python
import uuid
from datetime import UTC, date, datetime, time, timedelta
from typing import Annotated

from fastapi import APIRouter, Query
from sqlalchemy import func, select

from app.deps import CurrentUser, Db
from app.models import Transaction
from app.pagination import PageDep
from app.routers.accounts import get_account_or_404
from app.schemas.common import Paginated
from app.schemas.transactions import TransactionOut

router = APIRouter(prefix="/api/accounts", tags=["transactions"])


def _start_of_day(day: date) -> datetime:
    return datetime.combine(day, time.min, tzinfo=UTC)


@router.get("/{account_id}/transactions", response_model=Paginated[TransactionOut])
def list_transactions(
    account_id: uuid.UUID,
    user: CurrentUser,
    db: Db,
    page: PageDep,
    from_: Annotated[date | None, Query(alias="from")] = None,
    to: date | None = None,
):
    account = get_account_or_404(db, user, account_id)
    conditions = [Transaction.org_id == user.org_id, Transaction.account_id == account.id]
    if from_ is not None:
        conditions.append(Transaction.occurred_at >= _start_of_day(from_))
    if to is not None:
        conditions.append(Transaction.occurred_at < _start_of_day(to + timedelta(days=1)))

    total = db.scalar(select(func.count()).select_from(Transaction).where(*conditions))
    rows = db.scalars(
        select(Transaction)
        .where(*conditions)
        .order_by(Transaction.occurred_at.desc(), Transaction.id)
        .limit(page.page_size)
        .offset(page.offset)
    ).all()
    return {"items": rows, "total": total, "page": page.page, "page_size": page.page_size}
```

In `backend/app/main.py`: import `transactions` alongside `accounts, auth` and add `app.include_router(transactions.router)`.

- [ ] **Step 4: Full verification and commit**

Run: `pytest --cov=app --cov-fail-under=80 && ruff check . && ruff format --check .`
Expected: all tests pass, coverage ≥ 80%, ruff clean.

Run: `uvicorn app.main:app --reload` then `curl -s localhost:8000/health`
Expected: `{"status":"ok","db":"ok"}`. Stop the server.

```bash
git add -A && git commit -m "feat: account transactions endpoint"
```

**Plan 1 done when:** `pytest` is green as `portal_app`, including `test_rls.py` and the cross-tenant 404 tests. Continue with Plan 2.

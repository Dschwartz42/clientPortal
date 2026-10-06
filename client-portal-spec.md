# Spec: Multi-Tenant Client Portal

## 1. Overview

A SaaS web application where multiple organizations ("tenants") log in to a shared system to manage and monitor their own client accounts. All tenants share one backend and one PostgreSQL database, but each tenant can only ever see and modify its own data. Isolation is enforced in two layers: application code **and** PostgreSQL Row-Level Security (RLS).

**Core idea to be able to explain:** "Shared database, shared schema, tenant ID on every row, enforced by the database itself so a bug in application code can't leak data across tenants."

### Resume bullets this project must satisfy

| Resume claim | Where it's satisfied |
|---|---|
| Multi-tenant SaaS client portal, React/TS frontend, Python REST API backend | Sections 3, 6, 7 |
| Organizations securely manage and monitor their own account data | Sections 4, 5, 6 |
| Tenant-scoped data access in PostgreSQL | Section 4.3 (RLS) |
| Role-based authentication | Section 5 |
| Deployed to Azure | Section 10 |
| CI/CD pipeline running automated tests on every PR | Section 9 |
| Reusable React components, UX-style design process | Section 7 |
| AI-assisted tools + unit and integration tests | Section 8 |

---

## 2. Users and roles

| Role | Can do |
|---|---|
| `admin` | Everything a member can, plus: create/edit/close accounts, invite users, change user roles, deactivate users, view audit log |
| `member` | View dashboard, view accounts and their transactions. Read-only. |

Rules:
- Every user belongs to exactly one organization.
- An organization must always have at least one active admin. The API rejects demoting or deactivating the last admin.
- An admin cannot deactivate themselves.

---

## 3. Tech stack

**Backend**
- Python 3.12
- FastAPI
- SQLAlchemy 2.0 (typed ORM style) + Alembic (migrations)
- psycopg 3 (Postgres driver)
- Pydantic v2 (request/response schemas), pydantic-settings (config)
- argon2-cffi (password hashing)
- PyJWT (tokens)
- pytest, httpx (test client), pytest-cov
- ruff (lint + format)
- Faker (seed data)

**Frontend**
- React 18 + TypeScript (strict mode) + Vite
- React Router v6
- TanStack Query (data fetching and caching)
- Recharts (charts)
- Tailwind CSS
- Vitest + React Testing Library
- ESLint

**Infrastructure**
- PostgreSQL 16 (Docker Compose locally)
- GitHub + GitHub Actions
- Azure App Service (Linux, container) for the API
- Azure Static Web Apps for the frontend
- Azure Database for PostgreSQL – Flexible Server

### Repository structure

```
client-portal/
├── backend/
│   ├── app/
│   │   ├── main.py              # FastAPI app, CORS, routers
│   │   ├── config.py            # Settings from env vars
│   │   ├── db.py                # Engine, session, tenant context
│   │   ├── security.py          # Hashing, JWT encode/decode
│   │   ├── deps.py              # get_current_user, require_admin, tenant session
│   │   ├── models/              # SQLAlchemy models
│   │   ├── schemas/             # Pydantic models
│   │   ├── routers/             # auth, accounts, transactions, analytics, users, audit
│   │   └── services/            # business logic (audit logging, analytics queries)
│   ├── alembic/                 # migrations, including RLS policies
│   ├── scripts/seed.py
│   ├── tests/
│   │   ├── unit/
│   │   └── integration/
│   ├── Dockerfile
│   └── pyproject.toml
├── frontend/
│   ├── src/
│   │   ├── api/                 # typed API client + query hooks
│   │   ├── auth/                # AuthContext, ProtectedRoute, RoleGate
│   │   ├── components/          # reusable UI components
│   │   ├── pages/
│   │   └── types/
│   └── package.json
├── docs/
│   ├── wireframes/              # sketches from the design step
│   └── architecture.md
├── docker-compose.yml
├── .github/workflows/
│   ├── ci.yml
│   └── deploy.yml
└── README.md
```

---

## 4. Data model

All primary keys are UUIDs (`gen_random_uuid()`). All timestamps are `timestamptz`.

### 4.1 Tables

**organizations**
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| name | text NOT NULL | |
| slug | text UNIQUE NOT NULL | e.g. `acme` |
| plan | text NOT NULL | CHECK in (`free`, `pro`, `enterprise`) |
| created_at | timestamptz NOT NULL DEFAULT now() | |

**users**
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| org_id | uuid NOT NULL FK → organizations | |
| email | citext UNIQUE NOT NULL | unique globally so login needs no org selector |
| password_hash | text NOT NULL | argon2 |
| full_name | text NOT NULL | |
| role | text NOT NULL | CHECK in (`admin`, `member`) |
| is_active | boolean NOT NULL DEFAULT true | |
| last_login_at | timestamptz NULL | |
| created_at | timestamptz NOT NULL DEFAULT now() | |

**accounts** (an organization's client accounts)
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| org_id | uuid NOT NULL FK → organizations | |
| name | text NOT NULL | client company name |
| status | text NOT NULL | CHECK in (`active`, `paused`, `closed`) |
| tier | text NOT NULL | CHECK in (`bronze`, `silver`, `gold`) |
| monthly_value | numeric(12,2) NOT NULL CHECK ≥ 0 | |
| owner_user_id | uuid NULL | composite FK, see below |
| opened_at | date NOT NULL | |
| closed_at | date NULL | |
| created_at | timestamptz NOT NULL DEFAULT now() | |

Constraints:
- `UNIQUE (org_id, id)` so other tables can reference `(org_id, id)`.
- Owner must belong to the same org: users gets `UNIQUE (org_id, id)` too, and accounts has `FOREIGN KEY (org_id, owner_user_id) REFERENCES users (org_id, id)`.

**transactions**
| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| org_id | uuid NOT NULL | |
| account_id | uuid NOT NULL | |
| type | text NOT NULL | CHECK in (`charge`, `refund`, `credit`) |
| amount | numeric(12,2) NOT NULL CHECK > 0 | always positive; type determines sign |
| description | text NULL | |
| occurred_at | timestamptz NOT NULL | |

Constraint: `FOREIGN KEY (org_id, account_id) REFERENCES accounts (org_id, id)` — the database itself guarantees a transaction can't point at another tenant's account. **This is a strong interview point.**

**audit_log**
| Column | Type | Notes |
|---|---|---|
| id | bigserial PK | |
| org_id | uuid NOT NULL | |
| actor_user_id | uuid NOT NULL | |
| action | text NOT NULL | e.g. `account.created`, `user.role_changed` |
| entity_type | text NOT NULL | |
| entity_id | uuid NOT NULL | |
| details | jsonb NOT NULL DEFAULT '{}' | before/after values |
| created_at | timestamptz NOT NULL DEFAULT now() | |

### 4.2 Indexes
- `users (org_id)`
- `accounts (org_id, status)`, `accounts (org_id, name)`
- `transactions (org_id, occurred_at DESC)`, `transactions (org_id, account_id, occurred_at DESC)`
- `audit_log (org_id, created_at DESC)`

Be ready to explain: every index leads with `org_id` because every query filters by tenant first.

### 4.3 Row-Level Security (the centerpiece)

**Two database roles:**
- `portal_owner` — owns the tables, runs Alembic migrations.
- `portal_app` — what the API connects as. Has only SELECT/INSERT/UPDATE/DELETE on tables. Not the owner, so RLS applies to it.

**Policies** (written in an Alembic migration with raw SQL):

```sql
ALTER TABLE accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON accounts
  USING (org_id = current_setting('app.current_org_id', true)::uuid)
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);
```

Repeat for `users`, `transactions`, `audit_log`. `organizations` gets a policy matching on `id` instead of `org_id`.

- `USING` filters what rows can be read/updated/deleted.
- `WITH CHECK` blocks inserting or updating a row into another tenant.
- `current_setting(..., true)` returns NULL if unset, so **an unset tenant context returns zero rows** (fail closed).

**Setting the tenant per request** (in `db.py` / `deps.py`):
- Each request gets its own session and transaction.
- After authenticating, the dependency runs `SELECT set_config('app.current_org_id', :org_id, true)`. The `true` means "local to this transaction," so the value can't leak to another request reusing the pooled connection. (Plain `SET LOCAL` can't take a bound parameter; `set_config` can, which avoids SQL injection.)

**Login problem:** at login there's no tenant yet, but `users` is RLS-protected. Solution: a `SECURITY DEFINER` function owned by `portal_owner`:

```sql
CREATE FUNCTION auth_find_user(p_email citext)
RETURNS TABLE (id uuid, org_id uuid, password_hash text, role text, is_active boolean)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT id, org_id, password_hash, role, is_active FROM users WHERE email = p_email;
$$;
REVOKE ALL ON FUNCTION auth_find_user FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_user TO portal_app;
```

**Defense in depth:** application queries also filter by `org_id` explicitly. RLS is the safety net if someone forgets.

---

## 5. Authentication and authorization

- `POST /api/auth/login` takes email + password. Verify with argon2. Same error message and similar timing for "no such user" and "wrong password" (don't reveal which emails exist). Inactive users rejected.
- On success, issue a JWT (HS256) signed with `JWT_SECRET`:
  ```json
  { "sub": "<user_id>", "org_id": "<org_id>", "role": "admin", "iat": ..., "exp": ... }
  ```
  Expiry: 60 minutes.
- Frontend sends `Authorization: Bearer <token>`. Token stored in memory, mirrored to `sessionStorage` so a refresh doesn't log out. Know the tradeoff vs. httpOnly cookies (XSS exposure vs. CSRF handling).
- `get_current_user` dependency: decode token → load user (under RLS with org set) → reject if missing or inactive. This means deactivating a user takes effect immediately even with a valid token.
- `require_admin` dependency: 403 if role isn't `admin`.
- **Terminology to get right:** authentication = who you are (login, JWT). Authorization = what you can do (roles, RLS).

---

## 6. API

Base path `/api`. JSON only. All endpoints except login and health require a token.

**Conventions**
- List responses: `{ "items": [...], "total": 123, "page": 1, "page_size": 25 }`. `page_size` max 100.
- Errors: `{ "error": { "code": "not_found", "message": "..." } }`.
- **Cross-tenant access returns 404, not 403.** Returning 403 would confirm the ID exists in another tenant.
- Validation errors: 422.

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/health` | public | `{ "status": "ok", "db": "ok" }` |
| POST | `/api/auth/login` | public | Returns `{ access_token, user }` |
| GET | `/api/auth/me` | any | Current user + org name |
| GET | `/api/accounts` | any | Query params: `status`, `tier`, `search` (name ILIKE), `sort` (`name`, `-monthly_value`, `opened_at`…), `page`, `page_size` |
| POST | `/api/accounts` | admin | Create account. Writes audit log. |
| GET | `/api/accounts/{id}` | any | Account detail incl. owner name, 30-day revenue |
| PATCH | `/api/accounts/{id}` | admin | Partial update. Setting status `closed` sets `closed_at`. Audit log with before/after. |
| DELETE | `/api/accounts/{id}` | admin | Only if account has no transactions; otherwise 409 telling the user to close it instead. |
| GET | `/api/accounts/{id}/transactions` | any | Paginated, newest first, optional `from`/`to` |
| GET | `/api/analytics/summary` | any | See below |
| GET | `/api/analytics/timeseries` | any | `metric` = `net_revenue` or `new_accounts`; `interval` = `week` or `month`; `from`, `to`. Returns `[{ period, value }]` with zero-filled gaps (use `generate_series`). |
| GET | `/api/analytics/top-accounts` | any | `limit` (default 5), `days` (default 90). By net revenue. |
| GET | `/api/users` | admin | Users in org |
| POST | `/api/users` | admin | Invite: email, full_name, role. Returns a one-time temporary password. |
| PATCH | `/api/users/{id}` | admin | Change role / is_active. Enforces last-admin and self-deactivation rules (409). |
| GET | `/api/audit-log` | admin | Paginated, filter by `action` |

**Analytics summary response:**
```json
{
  "active_accounts": 142,
  "total_monthly_value": "184250.00",
  "net_revenue_30d": "61200.50",
  "net_revenue_prev_30d": "55870.00",
  "net_revenue_change_pct": 9.54
}
```
Net revenue = sum(charges) − sum(refunds) − sum(credits). Money is returned as strings to avoid float rounding; the frontend formats it.

---

## 7. Frontend

### 7.1 Design process (do this first, ~1 hour)
1. Write 3 user stories in `docs/wireframes/README.md`, e.g. "As an org admin, I want to see at a glance whether revenue is up or down this month."
2. Sketch wireframes (paper photo or Figma) for Dashboard, Accounts list, Account detail, Users admin.
3. Note one decision you made from it (e.g. "put the revenue trend above the fold because that's the first question an admin asks"). This is your UX-process interview story.

### 7.2 Pages and routes
| Route | Access | Contents |
|---|---|---|
| `/login` | public | Email/password form, error display |
| `/` → `/dashboard` | any | 4 MetricCards (active accounts, monthly value, 30d net revenue with % change, top tier count), net revenue TrendChart (monthly, last 12 months), new-accounts bar chart, Top 5 accounts table |
| `/accounts` | any | DataTable with search, status/tier filters, sort, pagination. "New account" button (admin only). Filters reflected in URL query string. |
| `/accounts/:id` | any | Header with status badge, details, 30d revenue, transactions table, Edit/Close buttons (admin only) |
| `/admin/users` | admin | Users table, invite modal (shows temp password once), role/active toggles |
| `/admin/audit` | admin | Audit log table |
| `*` | | 404 page |

Org name and the user's name/role are shown in the top bar so it's obvious which tenant you're in during a demo.

### 7.3 Reusable components (`src/components/`)
| Component | Props / behavior |
|---|---|
| `AppShell` | Sidebar nav (admin links hidden for members), top bar, `<Outlet/>` |
| `ProtectedRoute` | Redirects to `/login` if no token |
| `RoleGate` | `role="admin"`; renders children only for that role. **UI convenience only — the API enforces the real rule.** |
| `MetricCard` | `label`, `value`, optional `change` (number, colored up/down), `format` (`currency`/`number`/`percent`), `loading` |
| `DataTable<T>` | Generic. `columns: { key, header, render?, sortable? }[]`, `rows: T[]`, `sort`, `onSortChange`, `page`, `pageSize`, `total`, `onPageChange`, `onRowClick?`, `loading`, `emptyMessage` |
| `TrendChart` | `data: { period, value }[]`, `type` (`line`/`bar`), `format` |
| `StatusBadge` | `status` → colored pill |
| `Modal`, `FormField`, `Button` | Basic building blocks |
| `LoadingSkeleton`, `EmptyState`, `ErrorState` | Every data view handles loading, empty, and error |

### 7.4 Data layer
- `src/api/client.ts`: `fetch` wrapper that adds the bearer token, parses the error format, and on 401 clears auth and redirects to login.
- `src/types/`: TypeScript types matching API schemas. Stretch: generate them from FastAPI's OpenAPI spec with `openapi-typescript`.
- One TanStack Query hook per endpoint (`useAccounts(params)`, `useAnalyticsSummary()`…). Mutations invalidate related queries.

---

## 8. Seed data (`backend/scripts/seed.py`)

- Run with `python -m scripts.seed --reset`. `--reset` truncates all tables first. Runs as `portal_owner`.
- `Faker.seed(42)` and `random.seed(42)` so data is identical every run.

| Org | Plan | Accounts | Story in the data |
|---|---|---|---|
| Acme Corp (`acme`) | enterprise | 220 | Steady growth: ~5% more revenue each month |
| Globex (`globex`) | pro | 90 | Declining: revenue drops from month 6, more closures |
| Initech (`initech`) | free | 25 | Small and flat |
| Umbrella Health (`umbrella`) | pro | 70 | Big spike in month 9, then back to normal |

- 12 months of transactions ending today. ~90% charges, ~6% refunds, ~4% credits. Amounts scale with account tier.
- Per org: 1–2 admins and 2–4 members. Demo logins: `admin@<slug>.test` and `member@<slug>.test`, password `DemoPass123!` (printed by the script, listed in README, demo-only).
- One deactivated user per org.
- Audit log: a few dozen realistic entries.
- Script prints a summary: row counts per org.

---

## 9. Testing

### 9.1 Backend (pytest)
Test database: separate `portal_test` database, migrated with Alembic at session start. Tests connect as `portal_app` so RLS is actually exercised. Each test runs in a transaction rolled back at the end. Fixtures create two orgs (A and B), each with an admin and a member, plus a few accounts and transactions with known values.

**Unit tests**
- Password hash verifies correct password, rejects wrong one.
- JWT round-trip; expired token rejected; tampered token rejected.
- Net revenue calculation for a known set of transactions.
- Last-admin rule logic.

**Integration tests (through the API)**
- Login success returns token; wrong password → 401; unknown email → same 401 message; inactive user → 401.
- No token → 401 on protected endpoints.
- Org A user lists accounts → only Org A accounts.
- **Org A user GETs Org B's account by ID → 404.**
- **Org A admin PATCHes Org B's account → 404, and B's row unchanged.**
- Org A admin creates an account → row has `org_id` A even if the body tries to send a different org_id.
- Member POST `/api/accounts` → 403.
- Member GET `/api/users` → 403.
- Demoting the last admin → 409. Deactivated user's existing token → 401.
- Analytics summary returns expected numbers for fixture data.
- Pagination: `total` correct, `page_size` capped at 100.

**Database-level RLS tests (no API — direct SQL as `portal_app`)**
- With `app.current_org_id` = A, `SELECT * FROM accounts` returns only A's rows.
- With no org set → zero rows.
- Inserting a row with B's org_id while set to A → error.
- Inserting a transaction for A that references B's account → foreign key error.

Coverage target: ≥ 80% on `app/`.

### 9.2 Frontend (Vitest + React Testing Library)
- `DataTable` renders rows, calls `onSortChange` when a sortable header is clicked, shows `emptyMessage` with no rows.
- `MetricCard` shows positive change in green, negative in red.
- `RoleGate` hides children for members.
- Login page shows an error message on failed login (mock fetch).

---

## 10. CI/CD and deployment

### 10.1 CI — `.github/workflows/ci.yml`
Triggers: `pull_request` to `main`, `push` to `main`.

**Job `backend`**
- `services: postgres:16` with health check.
- Set up Python 3.12, install deps (cache pip).
- Create `portal_owner` and `portal_app` roles and the test DB (small SQL script in `backend/scripts/ci_db_setup.sql`).
- `ruff check .` and `ruff format --check .`
- `alembic upgrade head`
- `pytest --cov=app --cov-fail-under=80`

**Job `frontend`**
- Set up Node 20, `npm ci` (cache npm).
- `npm run lint`, `npx tsc --noEmit`, `npm run test -- --run`, `npm run build`

In GitHub settings, protect `main`: require a PR and both CI jobs passing before merge. **Do at least a few real PRs** (feature branches) so the history shows the pipeline working.

### 10.2 CD — `.github/workflows/deploy.yml`
Trigger: `push` to `main` after CI passes (`workflow_run` on CI, or `needs:` in one workflow).
- Backend: build Docker image, deploy to Azure App Service, then run `alembic upgrade head` against Azure Postgres.
- Frontend: deploy `frontend/dist` to Azure Static Web Apps with the official action, with `VITE_API_URL` pointing at the App Service URL.
- Authenticate to Azure with **OIDC federated credentials** (no long-lived secrets in GitHub). Fallback: App Service publish profile stored as a GitHub secret.

### 10.3 Azure resources (one resource group, e.g. `rg-client-portal`)
| Resource | Tier |
|---|---|
| Azure Database for PostgreSQL – Flexible Server | Burstable B1ms; enable `citext` and `pgcrypto` extensions |
| App Service Plan (Linux) + Web App for container | B1 |
| Azure Static Web Apps | Free |
| (optional) Azure Container Registry | Basic — or push the image to GitHub Container Registry |

App Service settings (environment variables): `DATABASE_URL` (as `portal_app`), `JWT_SECRET`, `CORS_ORIGINS` (Static Web App URL). Postgres firewall allows Azure services. **Stop or delete resources after the interview process to avoid charges.**

### 10.4 Configuration
All config comes from environment variables via pydantic-settings. Commit a `.env.example`, never a real `.env`.

---

## 11. Build plan (3 days)

**Day 1 — Backend core**
- [ ] Repo, Docker Compose Postgres, FastAPI skeleton, `/health`
- [ ] Models + Alembic migration for all tables, constraints, indexes
- [ ] RLS migration, DB roles, `auth_find_user` function
- [ ] Seed script
- [ ] Auth (login, JWT, `get_current_user`, `require_admin`, tenant session)
- [ ] Accounts and transactions endpoints
- [ ] RLS SQL tests + cross-tenant integration tests passing

**Day 2 — Rest of API + frontend**
- [ ] Analytics, users, audit endpoints + their tests
- [ ] Wireframes
- [ ] Vite app, routing, auth context, API client
- [ ] Reusable components
- [ ] Dashboard, Accounts, Account detail, Admin pages

**Day 3 — Quality and shipping**
- [ ] Frontend tests
- [ ] CI workflow, branch protection, merge remaining work via PRs
- [ ] Azure resources, deploy workflow, seed the Azure database
- [ ] README: what it is, architecture diagram, how to run locally, demo logins, design decisions
- [ ] Click through the live site as two different orgs

**If behind schedule, cut in this order:** audit log page → frontend tests beyond DataTable/RoleGate → OIDC (use publish profile) → user invite flow. **Never cut:** RLS, cross-tenant tests, CI on PRs, deployment — those are on the resume.

---

## 12. Definition of done
- Live URL works; logging in as `admin@acme.test` and `admin@globex.test` shows visibly different data.
- `docker compose up` + seed + run gives a working local app from a fresh clone, following the README.
- CI is green on `main`, and at least 3 merged PRs show checks.
- Every resume bullet in section 1 maps to something real.

---

## 13. Interview questions to be ready for
1. Walk me through the architecture of this project.
2. Why shared-schema multi-tenancy instead of database-per-tenant or schema-per-tenant? What would make you switch?
3. How exactly does RLS work here? What happens if a developer forgets the `org_id` filter?
4. Why `set_config(..., true)` instead of a session-level `SET`? (Connection pooling.)
5. How does login work if the users table is under RLS?
6. Why return 404 instead of 403 for another tenant's resource?
7. Authentication vs. authorization — which is which in your app?
8. Why argon2 instead of SHA-256 for passwords?
9. What's in your JWT? What are the downsides of JWTs? How would you revoke one?
10. Why do your indexes start with `org_id`?
11. How do you prevent a transaction from referencing another tenant's account? (Composite foreign key.)
12. Show me your favorite test and explain it.
13. What does your CI pipeline do, step by step? What happens if a test fails on a PR?
14. How is the app deployed? Where do secrets live?
15. Why is money stored as `numeric` and sent as a string?
16. What would you change to support 10,000 tenants? (Connection pooling with PgBouncer, caching, noisy-neighbor limits, partitioning by org.)
17. How did you use AI tools, and how did you make sure the generated code was right?

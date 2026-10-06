# Client Portal — Plan 5 of 5: Azure Deployment and Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app is live on Azure, redeploys automatically when CI passes on `main`, and the repo has a README and architecture doc that a reviewer can follow from a fresh clone.

**Architecture:** The API runs as a container on Azure App Service, pulled from GitHub Container Registry. The frontend is static files on Azure Static Web Apps. PostgreSQL is an Azure Flexible Server with the same two roles as local. A `Deploy` workflow triggers when the `CI` workflow succeeds on a push to `main`; it authenticates to Azure with OIDC, so no long-lived Azure credential is stored in GitHub.

**Tech Stack:** Docker, GitHub Actions, GitHub Container Registry, Azure App Service (Linux, B1), Azure Static Web Apps (Free), Azure Database for PostgreSQL Flexible Server (B1ms), Azure CLI.

**Spec:** `client-portal-spec.md` — sections 10.2, 10.3, 10.4, 11 (Day 3), 12.

**Sequence:** Requires Plans 1–4 merged. Two PRs: the deploy workflow, then the docs.

**Who runs what:** Tasks 2–4 create billable Azure resources and credentials under Daniel's account. An agent must not run them unprompted: Daniel runs them, or explicitly approves each task. Tasks 1, 5 and 6 are ordinary repo work.

## Global Constraints

- One resource group, `rg-client-portal`. Postgres: Burstable B1ms with `citext` and `pgcrypto` allow-listed. App Service plan: Linux B1. Static Web Apps: Free.
- App Service settings: `DATABASE_URL` (as `portal_app`), `JWT_SECRET`, `CORS_ORIGINS` (the Static Web App URL), `WEBSITES_PORT=8000`.
- The API never connects as `portal_owner`. Only migrations and the seed do.
- Azure auth from GitHub is OIDC federated credentials. Fallback if OIDC setup is blocked: App Service publish profile as a GitHub secret.
- No real secret is committed. `.env.example` files only.
- Deploy runs only after CI succeeds on a push to `main`.
- **Stop or delete the Azure resources after the interview process** to avoid charges.

## Review Focus

1. Refreshing a deep link on the live site (`/accounts/<id>`) → the app loads, not a Static Web Apps 404 (Task 7 Step 2; `staticwebapp.config.json` from Plan 4).
2. `CORS_ORIGINS` set with a trailing slash or spaces (`https://x.azurestaticapps.net/, …`) → browser requests still pass CORS (Task 1 test).
3. The container is slow to start after a deploy → the deploy job waits and retries `/health` instead of reporting success on a dead app (Task 5 smoke step).
4. A migration fails during deploy → the job fails visibly and the schema is unchanged, because each Alembic migration runs in one transaction (Task 5; verified by reading the failed job, no test).
5. On the live database, `portal_app` with no tenant set sees zero rows (Task 3 Step 4).

---

### Task 1: Container image for the API

**Files:**
- Create: `backend/Dockerfile`, `backend/.dockerignore`
- Test: `backend/tests/unit/test_config.py`

- [ ] **Step 1: Branch and write the failing test**

```bash
git switch main && git pull && git switch -c feat/deploy
```

`backend/tests/unit/test_config.py`:

```python
from app.config import Settings


def _settings(cors_origins: str) -> Settings:
    return Settings(
        database_url="postgresql+psycopg://u:p@localhost/db",
        jwt_secret="x" * 32,
        cors_origins=cors_origins,
    )


def test_cors_origins_are_split_trimmed_and_lose_trailing_slashes():
    settings = _settings(" https://portal.azurestaticapps.net/ , http://localhost:5173 ,")
    assert settings.cors_origin_list == [
        "https://portal.azurestaticapps.net",
        "http://localhost:5173",
    ]


def test_single_origin():
    assert _settings("http://localhost:5173").cors_origin_list == ["http://localhost:5173"]
```

Run: `cd backend && source .venv/bin/activate && pytest tests/unit/test_config.py -v`
Expected: PASS already — Plan 1's `cors_origin_list` handles this. The test pins the behaviour before production depends on it. If it fails, fix `app/config.py` to match the test.

- [ ] **Step 2: Dockerfile**

`backend/Dockerfile`:

```dockerfile
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app

COPY pyproject.toml alembic.ini ./
COPY app ./app
COPY scripts ./scripts
COPY alembic ./alembic
RUN pip install --no-cache-dir .

RUN useradd --create-home appuser
USER appuser

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

`backend/.dockerignore`:

```gitignore
.venv
.env
__pycache__
.pytest_cache
.ruff_cache
.coverage
tests
```

- [ ] **Step 3: Build and smoke-test locally**

```bash
docker compose up -d
docker build -t client-portal-api backend
docker run --rm -d --name portal-api-test -p 8001:8000 \
  -e DATABASE_URL=postgresql+psycopg://portal_app:app_pw@host.docker.internal:5432/portal \
  -e JWT_SECRET=local-container-secret-0123456789abcdef \
  client-portal-api
sleep 3 && curl -s localhost:8001/health; docker stop portal-api-test
```

Expected: `{"status":"ok","db":"ok"}`.

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "build: API container image"
```

---

### Task 2: Azure resources (Daniel runs; billable)

Approximate cost while running: B1ms Postgres plus a B1 App Service plan, roughly USD 25–30 per month combined. Static Web Apps Free is free.

- [ ] **Step 1: Install and sign in**

```bash
brew install azure-cli
az login
az account show --query "{name:name, id:id}" -o table
```

Expected: the subscription you intend to bill.

- [ ] **Step 2: Choose names and generate secrets**

Run these in one terminal session and keep it open through Task 4 (later steps reuse the variables). Save the three passwords in your password manager.

```bash
RG=rg-client-portal
LOC=eastus
SUFFIX=$(openssl rand -hex 3)              # makes the global names unique
PG=pg-client-portal-$SUFFIX
PLAN=plan-client-portal
APP=app-client-portal-$SUFFIX
SWA=swa-client-portal-$SUFFIX
PG_ADMIN_PW=$(openssl rand -hex 16)        # hex only, so it is safe inside a URL
OWNER_PW=$(openssl rand -hex 16)
APP_PW=$(openssl rand -hex 16)
PG_HOST=$PG.postgres.database.azure.com
echo "$PG $APP $SWA"; echo "admin=$PG_ADMIN_PW owner=$OWNER_PW app=$APP_PW"
```

- [ ] **Step 3: Resource group and PostgreSQL**

```bash
az group create -n $RG -l $LOC
az postgres flexible-server create -g $RG -n $PG -l $LOC \
  --tier Burstable --sku-name Standard_B1ms --version 16 --storage-size 32 \
  --admin-user pgadmin --admin-password "$PG_ADMIN_PW" \
  --public-access 0.0.0.0 --yes
az postgres flexible-server parameter set -g $RG -s $PG \
  --name azure.extensions --value CITEXT,PGCRYPTO
az postgres flexible-server db create -g $RG -s $PG -d portal
```

`--public-access 0.0.0.0` creates the "allow Azure services" firewall rule: App Service and GitHub-hosted runners (which run in Azure) can connect; the open internet cannot.

Expected: `az postgres flexible-server show -g $RG -n $PG --query state -o tsv` prints `Ready`.

- [ ] **Step 4: App Service and Static Web App**

```bash
az appservice plan create -g $RG -n $PLAN --is-linux --sku B1
az webapp create -g $RG -p $PLAN -n $APP \
  --container-image-name mcr.microsoft.com/appsvc/staticsite:latest
az staticwebapp create -g $RG -n $SWA -l eastus2 --sku Free
SWA_HOST=$(az staticwebapp show -g $RG -n $SWA --query defaultHostname -o tsv)

az webapp config appsettings set -g $RG -n $APP --settings \
  DATABASE_URL="postgresql+psycopg://portal_app:$APP_PW@$PG_HOST:5432/portal?sslmode=require" \
  JWT_SECRET="$(openssl rand -hex 32)" \
  CORS_ORIGINS="https://$SWA_HOST" \
  WEBSITES_PORT=8000
az webapp config set -g $RG -n $APP --always-on true \
  --generic-configurations '{"healthCheckPath": "/health"}'
echo "API: https://$APP.azurewebsites.net   Frontend: https://$SWA_HOST"
```

The placeholder image is replaced by the first deploy. Azure CLI flag names change between versions; if a command rejects a flag, check `az <command> --help` rather than guessing.

Expected: both URLs print. The frontend URL shows Azure's default page for now.

---

### Task 3: Database roles, migrations and seed on Azure (Daniel runs)

- [ ] **Step 1: Temporarily allow your own IP**

```bash
MYIP=$(curl -s https://ifconfig.me)
az postgres flexible-server firewall-rule create -g $RG -n $PG \
  --rule-name laptop --start-ip-address $MYIP --end-ip-address $MYIP
```

- [ ] **Step 2: Create the two roles**

`psql` runs from the Postgres image, so nothing needs installing.

```bash
docker run --rm -i -e PGPASSWORD="$PG_ADMIN_PW" postgres:16 \
  psql "host=$PG_HOST user=pgadmin dbname=portal sslmode=require" -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE portal_owner LOGIN PASSWORD '$OWNER_PW';
CREATE ROLE portal_app LOGIN PASSWORD '$APP_PW';
GRANT portal_owner TO pgadmin;
ALTER DATABASE portal OWNER TO portal_owner;
GRANT ALL ON SCHEMA public TO portal_owner;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
SQL
```

Expected: `CREATE ROLE` twice, then `GRANT`, `ALTER DATABASE`, `GRANT`, `CREATE EXTENSION` twice.

- [ ] **Step 3: Migrate and seed as `portal_owner`**

```bash
cd backend && source .venv/bin/activate
export MIGRATION_DATABASE_URL="postgresql+psycopg://portal_owner:$OWNER_PW@$PG_HOST:5432/portal?sslmode=require"
alembic upgrade head
python -m scripts.seed --reset
```

`DATABASE_URL` and `JWT_SECRET` still come from your local `.env`; only the owner URL is overridden, and only in this shell.

Expected: Alembic applies `0001` and `0002`; the seed prints the four-org summary and the demo logins.

- [ ] **Step 4: Verify isolation on the live database**

```bash
docker run --rm -i -e PGPASSWORD="$APP_PW" postgres:16 \
  psql "host=$PG_HOST user=portal_app dbname=portal sslmode=require" -c "SELECT count(*) FROM accounts"
```

Expected: `0`. The app role with no tenant set sees nothing.

- [ ] **Step 5: Remove the laptop firewall rule**

```bash
az postgres flexible-server firewall-rule delete -g $RG -n $PG --rule-name laptop --yes
unset MIGRATION_DATABASE_URL && cd ..
```

Re-add it the same way whenever you need to re-seed.

---

### Task 4: OIDC trust and GitHub configuration (Daniel runs)

- [ ] **Step 1: Create the identity GitHub will use**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
SUB=$(az account show --query id -o tsv)
TENANT=$(az account show --query tenantId -o tsv)
CLIENT_ID=$(az ad app create --display-name gh-client-portal-deploy --query appId -o tsv)
az ad sp create --id $CLIENT_ID
az role assignment create --assignee $CLIENT_ID --role "Website Contributor" \
  --scope /subscriptions/$SUB/resourceGroups/$RG
az ad app federated-credential create --id $CLIENT_ID --parameters "{
  \"name\": \"github-main\",
  \"issuer\": \"https://token.actions.githubusercontent.com\",
  \"subject\": \"repo:$REPO:ref:refs/heads/main\",
  \"audiences\": [\"api://AzureADTokenExchange\"]
}"
```

The identity can only manage web apps in this one resource group, and only workflows running on `main` of this repo can assume it. There is no password or key to leak.

- [ ] **Step 2: GitHub variables and secrets**

```bash
gh variable set AZURE_CLIENT_ID --body "$CLIENT_ID"
gh variable set AZURE_TENANT_ID --body "$TENANT"
gh variable set AZURE_SUBSCRIPTION_ID --body "$SUB"
gh variable set AZURE_WEBAPP_NAME --body "$APP"
gh variable set API_URL --body "https://$APP.azurewebsites.net"
gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN \
  --body "$(az staticwebapp secrets list -g $RG -n $SWA --query properties.apiKey -o tsv)"
gh secret set MIGRATION_DATABASE_URL \
  --body "postgresql+psycopg://portal_owner:$OWNER_PW@$PG_HOST:5432/portal?sslmode=require"
```

The three Azure IDs are identifiers, not credentials, so they are variables. Static Web Apps deploys with its own deployment token; OIDC covers the App Service deploy.

Expected: `gh variable list` shows five variables; `gh secret list` shows two secrets.

---

### Task 5: Deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Write the workflow**

`.github/workflows/deploy.yml`:

```yaml
name: Deploy

on:
  workflow_run:
    workflows: [CI]
    types: [completed]
    branches: [main]

permissions:
  contents: read
  packages: write
  id-token: write # lets the job request an OIDC token for Azure

concurrency:
  group: deploy
  cancel-in-progress: false

jobs:
  backend:
    # Only after CI passed, and only for pushes to main (not PR runs).
    if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - name: Compute image name
        run: echo "IMAGE=ghcr.io/${GITHUB_REPOSITORY_OWNER,,}/client-portal-api:${{ github.event.workflow_run.head_sha }}" >> "$GITHUB_ENV"

      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - uses: docker/build-push-action@v6
        with:
          context: backend
          push: true
          tags: ${{ env.IMAGE }}

      - uses: azure/login@v2
        with:
          client-id: ${{ vars.AZURE_CLIENT_ID }}
          tenant-id: ${{ vars.AZURE_TENANT_ID }}
          subscription-id: ${{ vars.AZURE_SUBSCRIPTION_ID }}

      - uses: azure/webapps-deploy@v3
        with:
          app-name: ${{ vars.AZURE_WEBAPP_NAME }}
          images: ${{ env.IMAGE }}

      - uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Run migrations
        working-directory: backend
        run: |
          pip install .
          alembic upgrade head
        env:
          MIGRATION_DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}
          # Settings requires these two; migrations do not use them.
          DATABASE_URL: ${{ secrets.MIGRATION_DATABASE_URL }}
          JWT_SECRET: not-used-by-migrations-0123456789abcdef

      - name: Wait for the API to come up
        run: curl --fail --silent --show-error --retry 18 --retry-delay 10 --retry-all-errors "${{ vars.API_URL }}/health"

  frontend:
    if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.event == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha }}

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: frontend/package-lock.json

      - name: Build
        working-directory: frontend
        run: npm ci && npm run build
        env:
          VITE_API_URL: ${{ vars.API_URL }}

      - uses: Azure/static-web-apps-deploy@v1
        with:
          azure_static_web_apps_api_token: ${{ secrets.AZURE_STATIC_WEB_APPS_API_TOKEN }}
          action: upload
          app_location: frontend/dist
          skip_app_build: true
          skip_api_build: true
```

The spec's order is kept: deploy, then migrate. Be ready to discuss the tradeoff: for a migration the new code depends on, there is a short window where the new container runs against the old schema. Migrating first is safer when migrations are additive.

- [ ] **Step 2: PR and merge**

```bash
git add -A && git commit -m "ci: deploy API and frontend to Azure after CI passes on main"
git push -u origin feat/deploy
gh pr create --title "ci: Azure deployment" --body "Container image for the API and a Deploy workflow (spec section 10.2). Authenticates to Azure with OIDC."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch main && git pull
```

- [ ] **Step 3: Watch the first deploy**

The merge triggers CI on `main`; when it succeeds, Deploy starts.

Run: `gh run list --workflow Deploy --limit 1` then `gh run watch <run-id>`
Expected: `frontend` succeeds. `backend` pushes the image and deploys, but the health wait is likely to **fail on this first run**: new GHCR packages are private and App Service cannot pull them.

- [ ] **Step 4 (Daniel): Make the image pullable, then re-run**

On GitHub: your profile → Packages → `client-portal-api` → Package settings → Change visibility → Public. (Alternative if the image must stay private: set `DOCKER_REGISTRY_SERVER_URL`, `DOCKER_REGISTRY_SERVER_USERNAME` and `DOCKER_REGISTRY_SERVER_PASSWORD` app settings with a token that has `read:packages`.)

Run: `gh run rerun <run-id> --failed && gh run watch <run-id>`
Expected: `backend` passes, ending with `{"status":"ok","db":"ok"}` from the health step.

If `Run migrations` cannot connect, the runner was not covered by the "allow Azure services" rule; run `alembic upgrade head` from your laptop as in Task 3 and note it in the README.

---

### Task 6: README and architecture doc

**Files:**
- Create: `README.md`, `docs/architecture.md`

Replace `<FRONTEND_URL>` and `<API_URL>` with the two URLs printed in Task 2 Step 4. They are the only values that are not known until the resources exist.

- [ ] **Step 1: Branch and write the architecture doc**

```bash
git switch -c docs/readme-architecture
```

`docs/architecture.md`:

````markdown
# Architecture

```mermaid
flowchart LR
    B[Browser: React SPA] -- HTTPS, Bearer JWT --> A[FastAPI on App Service]
    S[Azure Static Web Apps] -- serves static files --> B
    A -- connects as portal_app --> P[(PostgreSQL: RLS on every tenant table)]
    G[GitHub Actions] -- OIDC --> A
    G -- deployment token --> S
    G -- alembic upgrade, as portal_owner --> P
```

## One request, end to end

1. The browser sends `Authorization: Bearer <JWT>`. The token carries `sub`, `org_id` and `role`.
2. `get_current_user` verifies the signature and expiry, then runs
   `SELECT set_config('app.current_org_id', <org_id>, true)` on the request's transaction.
3. It loads the user row. If the user is missing or deactivated the request ends with 401,
   so deactivation takes effect immediately even though the token is still valid.
4. The route queries with an explicit `org_id` filter.
5. PostgreSQL applies the `tenant_isolation` policy to every statement as well. If step 4
   were ever forgotten, the policy still returns only the caller's rows.
6. The transaction ends and the setting disappears with it, so the pooled connection
   carries nothing into the next request.

## Tenant isolation, layer by layer

| Layer | What it guarantees |
|---|---|
| Application filter (`WHERE org_id = :org`) | Correct results and index use in the normal case |
| RLS policy `USING` | Reads, updates and deletes only ever see the caller's tenant |
| RLS policy `WITH CHECK` | A row cannot be inserted into, or moved to, another tenant |
| Composite foreign keys `(org_id, id)` | A transaction or account owner cannot point across tenants |
| Separate DB roles | The API role is not the table owner, so it cannot bypass RLS |
| 404 for other tenants' IDs | The API does not confirm that an ID exists elsewhere |

## Two details worth knowing

- **`NULLIF(current_setting('app.current_org_id', true), '')::uuid`** — once a custom setting
  has been used on a connection it reads back as an empty string, not NULL, after the
  transaction ends. `NULLIF` makes "no tenant set" mean "zero rows" rather than a cast error.
- **`users` is `ENABLE` but not `FORCE` row level security** — login must find a user before
  any tenant is known. It does so through `auth_find_user`, a `SECURITY DEFINER` function
  owned by `portal_owner`. With `FORCE`, the owner would be filtered too and nobody could
  log in. The API role is not the owner, so RLS on `users` still applies to it in full.

## Roles

| Role | Used by | Can do |
|---|---|---|
| `portal_owner` | Alembic, seed script | Owns tables; DDL |
| `portal_app` | The API | SELECT / INSERT / UPDATE / DELETE, subject to RLS; EXECUTE on `auth_find_user` |

## What would change at 10,000 tenants

Connection pooling in front of Postgres (PgBouncer in transaction mode works because the
tenant setting is transaction-local), caching for analytics, per-tenant rate limits for
noisy neighbours, and partitioning the large tables by `org_id`.
````

- [ ] **Step 2: Write the README**

`README.md`:

````markdown
# Client Portal

A multi-tenant SaaS portal. Several organizations share one backend and one PostgreSQL
database, and each can see and change only its own client accounts. Isolation is enforced
twice: in application code and by PostgreSQL Row-Level Security, so a bug in a query cannot
leak one tenant's data to another.

**Live demo:** <FRONTEND_URL> · API health: <API_URL>/health

| Demo login | Password | What you will see |
|---|---|---|
| `admin@acme.test` / `member@acme.test` | `DemoPass123!` | Steady growth |
| `admin@globex.test` / `member@globex.test` | `DemoPass123!` | Declining revenue, more closures |
| `admin@initech.test` / `member@initech.test` | `DemoPass123!` | Small and flat |
| `admin@umbrella.test` / `member@umbrella.test` | `DemoPass123!` | One big spike |

Demo credentials only. Log in as two different organizations to see the isolation.

## Stack

- **Backend:** Python 3.12, FastAPI, SQLAlchemy 2.0, Alembic, psycopg 3, PostgreSQL 16
- **Frontend:** React 18, TypeScript, Vite, TanStack Query, React Router, Recharts, Tailwind
- **Infra:** GitHub Actions, Azure App Service (container), Azure Static Web Apps,
  Azure Database for PostgreSQL

Architecture and request flow: [docs/architecture.md](docs/architecture.md).
Design notes and wireframes: [docs/wireframes/](docs/wireframes/).

## Run it locally

Requires Docker, Python 3.12 and Node 20+.

```bash
docker compose up -d                       # Postgres with both roles and both databases

cd backend
python3.12 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
cp .env.example .env
alembic upgrade head
python -m scripts.seed --reset             # prints the demo logins
uvicorn app.main:app --reload              # http://localhost:8000/docs

cd ../frontend                             # in a second terminal
npm install
npm run dev                                # http://localhost:5173
```

## Tests

```bash
cd backend && pytest --cov=app             # runs as the portal_app role against portal_test
cd frontend && npm run test -- --run
```

The backend suite has three layers: unit tests (hashing, JWT, revenue maths, the last-admin
rule), integration tests through the API (including "org A requests org B's account → 404"),
and database-level RLS tests that run raw SQL as the application role with no API involved.

## CI/CD

- **CI** (`.github/workflows/ci.yml`) runs on every pull request and on pushes to `main`:
  lint, format check, migrations and tests with an 80% coverage floor for the backend;
  lint, typecheck, tests and build for the frontend. `main` is protected: no merge without
  a PR and both jobs green.
- **Deploy** (`.github/workflows/deploy.yml`) runs when CI succeeds on `main`: builds and
  pushes the API image, deploys it to App Service, runs migrations, and publishes the
  frontend to Static Web Apps. GitHub authenticates to Azure with OIDC; no Azure password
  is stored in the repo.

## Design decisions

- **Shared schema with `org_id` on every row**, rather than a database or schema per tenant:
  one migration path and cheap onboarding. Worth revisiting if a tenant needed physical
  isolation or its own region.
- **RLS as the safety net.** The API connects as a role that does not own the tables, sets
  the tenant per transaction with `set_config(..., true)`, and still filters by `org_id`
  in every query.
- **Composite foreign keys** `(org_id, id)` so a transaction cannot reference another
  tenant's account, whatever the application does.
- **404, not 403, for another tenant's resource**, so the API never confirms an ID exists.
- **Money is `numeric(12,2)` in the database and a string in JSON** to avoid float rounding.
- **JWT in memory, mirrored to `sessionStorage`.** Simple and immune to CSRF, at the cost of
  XSS exposure; httpOnly cookies would reverse that tradeoff. The user row is re-checked on
  every request, so deactivating a user takes effect immediately.
- **Email is unique across all tenants** so login needs no organization selector. The cost:
  inviting an address that exists in another tenant reveals that it is taken.

## How AI tools were used

Implementation was AI-assisted, working from a written spec and task-by-task plans
(`docs/superpowers/plans/`). Each behaviour was pinned by a test written before the code,
and the tenant-isolation tests run against a real PostgreSQL as the application role, so
generated code that broke isolation could not pass CI.
````

- [ ] **Step 3: PR and merge**

```bash
git add -A && git commit -m "docs: README and architecture"
git push -u origin docs/readme-architecture
gh pr create --title "docs: README and architecture" --body "How to run it, how isolation works, design decisions."
gh pr checks --watch
gh pr merge --squash --delete-branch
git switch main && git pull
```

---

### Task 7: Definition of done

- [ ] **Step 1: Fresh-clone check**

```bash
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
cd "$(mktemp -d)" && gh repo clone "$REPO" && cd client-portal
```

Follow the README's "Run it locally" section exactly as written, with no knowledge beyond it. (Stop the original `docker compose` stack first; both use port 5432.)
Expected: the app works. Fix the README, not your memory, if a step is missing.

- [ ] **Step 2: Click through the live site as two organizations**

On `<FRONTEND_URL>`:
- `admin@acme.test`: dashboard shows "Acme Corp" and a rising revenue line. Open an account and **refresh the page** — it reloads the account, not a 404.
- Copy that account's URL. Log out. Log in as `admin@globex.test`: "Globex", different numbers, a falling line. Paste the Acme URL → "Page not found".
- `member@globex.test`: no admin links, no edit buttons.
- Browser dev tools → Network: no CORS errors.

- [ ] **Step 3: Evidence for the resume bullets**

Run: `gh pr list --state merged --limit 20` and `gh run list --branch main --limit 5`
Expected: at least 3 merged PRs (this project produces 7), each with checks; latest CI and Deploy runs on `main` are green.

Walk the spec's section 1 table and confirm each row points at something real:

| Resume claim | Evidence |
|---|---|
| Multi-tenant portal, React/TS + Python REST API | Live URL; `frontend/`, `backend/` |
| Organizations manage and monitor their own data | Two logins, two different dashboards |
| Tenant-scoped data access in PostgreSQL | `alembic/versions/0002_rls.py`, `tests/integration/test_rls.py` |
| Role-based authentication | `app/deps.py`; member → 403 tests |
| Deployed to Azure | Live URL; `deploy.yml` |
| CI/CD running tests on every PR | Merged PRs with checks; the closed "prove CI goes red" PR |
| Reusable components, UX-style process | `frontend/src/components/`; `docs/wireframes/` |
| AI-assisted tools + unit and integration tests | `tests/unit`, `tests/integration`; README section |

- [ ] **Step 4 (Daniel, when the interview process ends): Stop the charges**

Deleting the resource group is permanent and removes the live demo and its database. Only Daniel runs this, when he decides to:

```bash
az group delete -n rg-client-portal
az ad app delete --id "$(gh variable get AZURE_CLIENT_ID)"
```

**Plan 5 done when:** every box in spec section 12 is true.

# Client Portal frontend

React 18 + TypeScript + Vite single-page app for the multi-tenant client portal.
It talks to the FastAPI backend in `../backend`.

## Commands

Requires Node 22 (22.22.2) or newer; `.nvmrc` pins the major version.

```bash
npm run dev               # start the dev server
npm run test -- --run     # run the Vitest suite once
npm run typecheck         # tsc against tsconfig.app.json
npm run lint              # ESLint
npm run build             # typecheck and production build into dist/
```

## Configuration

`VITE_API_URL` sets the API base URL. Copy `.env.example` to `.env` and edit it
(default `http://localhost:8000`).

Tests run with `TZ=America/Los_Angeles` (set in `vite.config.ts`) so date-only
formatting bugs show up regardless of the machine's timezone.

## Design notes

- **Session token.** The JWT lives in memory, mirrored to `sessionStorage` so a reload
  keeps the session. Any script on the page can read it (XSS exposure); in exchange no
  CSRF handling is needed.
- **React Router stays on v6**, as the spec requires. Its two moderate `npm audit`
  advisories are accepted: the app never passes user-controlled strings to `<Link>`,
  `<Navigate>` or `navigate()` (only fixed paths and server-issued ids) and does no
  server-side rendering. So never add a "return to" URL parameter.
- **Session check failures.** A non-401 failure of `/api/auth/me` keeps the token, so a
  transient outage does not end the session. Only a 401 does.
- **Roles.** The backend enforces them; the UI only mirrors them. After any 403, and
  after changing your own user, the role and admin controls are refreshed from the API.


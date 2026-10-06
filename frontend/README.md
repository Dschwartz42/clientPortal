# Client Portal frontend

React 18 + TypeScript + Vite single-page app for the multi-tenant client portal.
It talks to the FastAPI backend in `../backend`.

## Commands

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

# ADR 0003: Tooling and version choices

- Status: Accepted
- Date: 2026-11-21

## Context

The scaffold needs a fixed, working set of tools before feature work starts. Versions were checked
against the npm and PyPI registries in November 2026 and verified together (install, lint, typecheck,
test, build).

## Decision

- **Node 22 LTS** (`.nvmrc`), not Node 20: 22 is the current LTS line and Node 20 is end-of-life.
- **TypeScript 5.9** (strict, ES2022). TypeScript 6/7 exist, but typescript-eslint 8 supports only
  `<6.1`, and 5.9 needs no `baseUrl`/`moduleResolution` migrations. Upgrade once the lint stack supports 7.
- **ESLint 10 flat config** + typescript-eslint `strictTypeChecked` + `stylisticTypeChecked`.
  ESLint 9 was planned but is now marked unsupported on npm; ESLint 10 uses the same flat config
  and every plugin we use supports it.
- **Prettier 3** for JS/TS/JSON/Markdown formatting; `eslint-config-prettier` turns off conflicting rules.
- **Express 5**: stable, handles rejected promises in async handlers natively, and has official
  types (`@types/express` 5). No friction found in the scaffold.
- **Zod 4** for env and request validation; **pino** + **pino-http** for JSON logs with `x-request-id`.
- **Vite 8 + React 18**: React 18 per the spec; Vite 8 is current and supported by Vitest 5 and
  `@vitejs/plugin-react` 6.
- **Tailwind CSS v4** (`@tailwindcss/vite`, CSS-first config, no `tailwind.config.js`): this is
  the current shadcn/ui CLI default (`components.json` with empty `tailwind.config`, `tw-animate-css`,
  OKLCH neutral theme variables in `src/index.css`).
- **Vitest 5** for both JS apps (same runner as Vite; Jest-compatible API), with Supertest for API
  routes and React Testing Library + jsdom for the UI.
- **Python: Ruff** (lint + format, replaces flake8/isort/black) and **mypy --strict** on `app/`
  with the Pydantic plugin; **pytest** with FastAPI `TestClient`. `requires-python >=3.12`
  (production targets 3.12; 3.13 also works).

## Consequences

- Strict type-aware linting catches more bugs but is slower and occasionally needs explicit types.
- Using newer majors (ESLint 10, Vite 8, Tailwind 4) means some online examples are outdated;
  this ADR records why we did not pin older ones.
- Any version change should update this ADR.

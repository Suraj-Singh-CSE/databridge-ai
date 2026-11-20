# ADR 0001: Monorepo structure

- Status: Accepted
- Date: 2026-11-21

## Context

DataBridge AI has a web UI, a public API and an internal AI service, plus evaluation scripts and
infrastructure config. They change together (API contracts, shared env vars, the error envelope), and
the project is built by a small team, so coordinating several repositories would cost more than it saves.

## Decision

Use one Git repository with this layout: `apps/web`, `apps/api`, `apps/ai-service`, `eval/`, `infra/`,
`docs/adr/`, `.github/workflows/`. The two JavaScript apps are npm workspaces sharing one lockfile,
one ESLint flat config, one Prettier config and one `tsconfig.base.json` at the root. The Python
service is managed separately with its own `pyproject.toml` and virtualenv. Root scripts (`lint`,
`typecheck`, `test`, `build`, `format`, `format:check`) run across the JS workspaces.

## Consequences

- One pull request can change the API and the UI that uses it; CI checks them together.
- Shared tooling keeps code style and strictness identical across JS apps.
- npm workspaces are enough at this size; no Nx/Turborepo. Revisit if build times grow.
- Python is outside npm workspaces, so contributors run two setup steps (documented in README).

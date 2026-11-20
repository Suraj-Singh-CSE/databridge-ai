# ADR 0005: Authentication, sessions and project access

- Status: Accepted
- Date: 2026-11-21

## Context

DataBridge AI holds customer data from several systems, so every request must be tied to a person
with a role, every project must stay private to its members, and changes must be traceable. The
browser is a single-page app on one origin that talks only to `apps/api`. CLAUDE.md rule 4 fixes
the outline (bcrypt 12, 15-minute access JWT, 7-day rotated refresh token in an httpOnly cookie,
stored hashed); this ADR records how and why.

## Decision

**Two tokens.**

- **Access token**: a JWT (HS256, `jose`) valid for 15 minutes with claims `sub`, `role`,
  `type: "access"`, `iss`, `aud`. The client keeps it in memory and sends it as
  `Authorization: Bearer`. Verification pins the algorithm (`algorithms: ['HS256']`), issuer and
  audience, and rejects any token whose `type` is not `access` or whose role is unknown. Being
  stateless, it needs no database read per request; the price is that a role change or a revoked
  session takes up to 15 minutes to reach tokens already issued.
- **Refresh token**: 256 random bits (base64url), not a JWT, sent only as the `db_rt` cookie
  (`HttpOnly`, `SameSite=Strict`, `Secure` in production, `Path=/api/v1/auth`, 7 days). JavaScript
  cannot read it (XSS cannot steal it), the browser sends it only to the auth routes, and
  `SameSite=Strict` plus the CORS allow-list blocks cross-site use (CSRF). It is opaque because the
  server must look it up anyway to support revocation, so a signed format adds nothing.

**Stored hashed.** `refresh_tokens` holds `{ userId, tokenHash, familyId, expiresAt, revokedAt,
replacedBy, reuseDetectedAt }` with a TTL index on `expiresAt`. `tokenHash` is HMAC-SHA256 keyed
with `JWT_REFRESH_SECRET`: a database dump alone cannot be replayed or used to test guesses, and
rotating that secret signs everyone out.

**Rotation with reuse detection.** Each login starts a token _family_. `POST /auth/refresh`
atomically revokes the presented token (`revokedAt: null` is part of the update filter), issues a
new one in the same family and links it with `replacedBy`. If a token that is already revoked is
presented, someone kept a copy: the whole family is revoked (and marked `reuseDetectedAt`) and the
request gets 401, so both the thief and the user must sign in again. Because the marker is checked
after the new token is written, two refreshes racing on one token cannot leave a live token behind.

**Passwords.** 10-128 characters, bcrypt cost 12 with `bcryptjs` (pure JS, installs everywhere
including Alpine without a compiler; about 3x slower than native `bcrypt`, acceptable at our login
volume). bcrypt ignores input beyond 72 bytes, so we bcrypt the base64 SHA-256 of the password and
every character counts. Unknown emails are still checked against a dummy hash, and register hashes
before inserting, so response time does not reveal whether an email exists (beyond the 409 that
register must return).

**First user is admin.** If the `users` collection is empty, register claims a one-time
`app_meta` document (`_id: "first-admin"`, unique by construction). Only one caller can win the
claim, so simultaneous first registrations cannot create two admins. Everyone else starts as
`data_engineer`; admins will manage roles in a later milestone.

**Project privacy: 404, not 403.** `requireProjectAccess(min)` loads the project and resolves the
caller's access (`admin` > `owner` > member role `data_engineer` > `data_steward` > `viewer`).
Non-members get the same 404 as a project that does not exist, so ids cannot be probed. Members
who are known to the project but lack the level get 403. Global roles gate creation
(`admin`/`data_engineer`); project roles gate everything inside a project.

**Audit log.** `audit_logs` is append-only: no update/delete routes and Mongoose query hooks that
throw on any update or delete. Entries record actor, action, entity, before/after snapshots of
non-sensitive fields and the `requestId`. Passwords, hashes and tokens are never stored. Entries
outlive deleted projects.

**Edge protection.** helmet headers, CORS limited to `CORS_ORIGIN` with credentials, 1 MB JSON
limit, and `express-rate-limit` on `/api/v1/auth/*` (20 requests per 15 minutes per IP by default,
`AUTH_RATE_LIMIT_MAX` / `AUTH_RATE_LIMIT_WINDOW_MS`). `TRUST_PROXY` (default `false`) controls
whether `X-Forwarded-For` is believed; trusting it while the api port is reachable directly would
let clients choose their own IP and skip the limit.

## Consequences

- Testing: services depend on repository interfaces injected into `createApp`, so the same HTTP
  suite runs against in-memory repositories (anywhere) and real MongoDB (CI service container).
- Two browser tabs refreshing with the same cookie at the same moment are treated as reuse and
  signed out. Acceptable now; a short grace window is a possible refinement. The web app avoids
  it by serialising refreshes across tabs ([ADR 0007](0007-frontend-architecture-and-sessions.md)).

## Follow-ups

- Move the rate-limit store to Redis so limits hold across api replicas and restarts; consider
  counting only failed logins per account as well as per IP.
- Project deletion is a hard delete of the project document only. When sources, uploaded files and
  DuckDB files exist (M2), deletion must also remove them (or move to soft delete with a purge job).
- Admin endpoints to change user roles, plus "sign out everywhere" (revoke all families of a user).
- Audit writes are not in a transaction with the change they describe; use MongoDB transactions
  (replica set) once deployment provides one.

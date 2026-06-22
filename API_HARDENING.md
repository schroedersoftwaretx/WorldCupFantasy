# API hardening — request validation + rate limiting

Defensive hardening of the `app/api/**` route layer. No response shapes or
accepted inputs changed; failures continue to use the existing envelope
`{ ok: false, error: { message, code } }` via `handle()`/`err()`.

## What was added

- **`zod`** dependency.
- **`src/web/validate.ts`** — `parseBody(request, schema)` (malformed JSON →
  `INVALID_BODY` 400; schema violation → `VALIDATION` 400) and
  `parseQuery(searchParams, schema)`. Both throw `HttpError`, so failures flow
  through the existing envelope.
- **`src/web/rate-limit.ts`** — `rateLimit({ key, limit, windowMs })` throwing
  `HttpError("rate limit exceeded", "RATE_LIMITED", 429)` with a `Retry-After`
  header, plus `enforceRateLimit(request, …)` and `clientIp(request)`.
- **`src/web/api.ts`** — `HttpError`, `err()`, and `handle()` now carry optional
  response headers so the 429 `Retry-After` rides the standard envelope.

## Storage choice (rate limiter)

Behind a `RateLimitStore` interface. **Default = in-memory fixed window.** The
app deploys to Vercel (`vercel.json`), which is serverless — in-memory counters
are **per-instance**, so the limit is best-effort under fan-out. If
`UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` are set, the limiter
automatically uses Upstash Redis (REST, via `fetch`, no extra dependency) for a
shared, accurate limit. The limiter **fails open** if the store errors.

**IP caveat:** keys trust the platform's `x-forwarded-for` (reliable on Vercel's
edge). Behind a proxy that does not strip client-supplied `x-forwarded-for`,
per-IP limits could be spoofed — terminate TLS at a trusted proxy.

Requests are keyed by client IP plus the authenticated manager id where
available (`m<id>` else `anon`).

## Per-route coverage (36 routes)

Legend: ✅ added · — n/a · `parseStage`/`parseId` = existing path/query validator kept.

| # | Route | Method(s) | Schema | Rate limit |
|---|-------|-----------|--------|------------|
| 1 | `/api/account/notifications` | GET | — | — (read) |
| 1 | `/api/account/notifications` | PUT | ✅ `PreferenceUpdateSchema` | skipped (see below) |
| 2 | `/api/admin/stats` | POST | ✅ `StatEditSchema` (+`sanitizeStatEdit`) | ✅ admin-stat-edit |
| 3 | `/api/auth/session` | POST | ✅ `SessionSchema` | ✅ login (per-IP) |
| 3 | `/api/auth/session` | DELETE | — | — |
| 4 | `/api/cron/draft-tick` | GET | — | — (CRON_SECRET, idempotent) |
| 5 | `/api/cron/ingest-and-score` | GET | — | — (CRON_SECRET) |
| 6 | `/api/cron/ingest-scores` | GET | — | — (CRON_SECRET) |
| 7 | `/api/health` | GET | — | — (probe) |
| 8 | `/api/invites/[token]/accept` | POST | — (`token` path param) | ✅ invite-accept |
| 9 | `/api/leagues/[leagueId]/awards` | GET | — | — (read) |
| 10 | `/api/leagues/[leagueId]/draft/board` | GET | — | — (read) |
| 11 | `/api/leagues/[leagueId]/draft/force-pick` | POST | — (no body) | ✅ draft-force-pick |
| 12 | `/api/leagues/[leagueId]/draft/pick` | POST | ✅ `PickSchema` | ✅ draft-pick |
| 13 | `/api/leagues/[leagueId]/draft/queue` | GET | — | — (read) |
| 13 | `/api/leagues/[leagueId]/draft/queue` | POST | ✅ `QueueActionSchema` | ✅ draft-queue |
| 14 | `/api/leagues/[leagueId]/draft` | GET | — | — (read) |
| 14 | `/api/leagues/[leagueId]/draft` | POST | ✅ `CreateDraftSchema` (tolerant/optional body) | ✅ draft-create |
| 15 | `/api/leagues/[leagueId]/draft/start` | POST | — (no body) | ✅ draft-start |
| 16 | `/api/leagues/[leagueId]/draft/stream` | GET | — | — (SSE; rate-limiting a long-lived stream is counterproductive) |
| 17 | `/api/leagues/[leagueId]/draft/tick` | POST | — (no body) | ✅ draft-tick |
| 18 | `/api/leagues/[leagueId]/flags` | GET | — | — (read) |
| 18 | `/api/leagues/[leagueId]/flags` | PUT | ✅ `FlagUpdateSchema` | ✅ flag-toggle |
| 19 | `/api/leagues/[leagueId]/invites` | POST | — (no body) | ✅ invite-create |
| 20 | `/api/leagues/[leagueId]/players/[playerId]/breakdown` | GET | — (`parseId`) | — (read) |
| 21 | `/api/leagues/[leagueId]/roster` | GET | ✅ `RosterQuerySchema` (teamId) | — (read) |
| 22 | `/api/leagues/[leagueId]` | GET | — | — (read) |
| 23 | `/api/leagues/[leagueId]/scoring` | PUT | ✅ `ScoringBodySchema` (+`sanitizeRulesetInput`) | ✅ scoring-edit |
| 24 | `/api/leagues/[leagueId]/standings/recompute` | POST | — (no body) | ✅ standings-recompute |
| 25 | `/api/leagues/[leagueId]/team` | PATCH | ✅ `RenameTeamSchema` | ✅ team-rename |
| 26 | `/api/leagues` | GET | — | — (read) |
| 26 | `/api/leagues` | POST | ✅ `CreateLeagueSchema` | skipped (see below) |
| 27 | `/api/notifications/[id]/read` | POST | — (`parseId`) | skipped (see below) |
| 28 | `/api/notifications` | GET | ✅ `InboxQuerySchema` (unread/limit, clamping) | — (read) |
| 29 | `/api/standings/[leagueId]` | GET | — (`parseId`) | — (read) |
| 30 | `/api/stats/adp` | GET | ✅ `AdpQuerySchema` | — (public read) |
| 31 | `/api/stats/awards` | GET | — | — (public read) |
| 32 | `/api/stats/leaderboards` | GET | `parseStage` (kept) | — (public read) |
| 33 | `/api/stats/ownership` | GET | ✅ `OwnershipQuerySchema` | — (public read) |
| 34 | `/api/stats/players/[playerId]/breakdown` | GET | — (`parseId`) | — (public read) |
| 35 | `/api/stats/records` | GET | — | — (public read) |
| 36 | `/api/stats/team-of-the-stage/[stage]` | GET | `parseStage` (kept) | — (public read) |

**Schemas added:** 14 route files. **Rate limits applied:** 14 endpoints.

### Deliberately skipped rate limits (candidates, not required by scope)
- `POST /api/leagues` (league create) — authed; low abuse value. Easy to add (`enforceRateLimit` + a `LIMITS.leagueCreate`).
- `PUT /api/account/notifications` and `POST /api/notifications/[id]/read` — authed, idempotent per-row toggles; not in the targeted set.
- All read-only GETs and SSE — left unlimited per spec (add a coarse global cap in `middleware.ts` if desired).
- Cron GETs — gated by `CRON_SECRET` and idempotent.

## Notes / follow-ups
- Error **codes** for structural failures are now standardized to `VALIDATION`
  (previously ad-hoc `BAD_REQUEST`/`INVALID_FLAG`/`INVALID_PREF`/`INVALID_QUEUE`/
  `INVALID_TEAM_NAME`/`MISSING_TEAM_ID`). Domain validators keep their specific
  codes (`INVALID_RULESET`, `INVALID_EDIT`). Accepted inputs are unchanged.
- A malformed JSON body on routes that previously parsed without a catch (team,
  flags, account prefs, queue) now returns `400 INVALID_BODY` instead of `500`.
- For production-accurate limits on Vercel, set the Upstash env vars; otherwise
  limits are per-instance.
- Optional: a coarse global limit in `middleware.ts` (kept per-handler here
  because it is precise and unit-testable).

## Verification
- `npm run typecheck` — clean.
- Unit + component suites pass (1 pre-existing unrelated failure in
  `test/unit/sofascore-mapping.test.ts`, present on `main` before these changes).
- Integration tests require Docker/Postgres and run in CI (`.github/workflows/ci.yml`).
- New tests: `test/unit/validate.test.ts`, `test/unit/rate-limit.test.ts`.

# Phase 0 — Shared Foundations

**Prerequisites:** none. This is the base every other phase builds on.
**Read first:** `PLAN.md` (sections 2 and 3 especially).

## Goal

Stand up the four reusable primitives the feature phases depend on so they
don't each reinvent them: a generalized **notification hub**, a reusable
**realtime feed helper**, **per-league feature flags**, and a **stats service
layer** + the navigation shell that surfaces the new sections.

Nothing user-visible ships a big feature here; this phase de-risks phases 1-8.

## Why

Several phases independently want "notify a manager", "push a live update", and
"is this feature on for this league?". Building those once, well, keeps the
later phases small and consistent. The existing `draft_notification` table and
the draft SSE route already prove the patterns — this phase promotes them to
shared infrastructure.

## Design / approach

### 0.1 Notification hub
Generalize the durable-queue idea behind `draft_notification` into an app-wide
`notification` table that any feature can write to, with the same write-row-then
-deliver guarantee. Keep `draft_notification` working (either leave it as-is and
add the new table alongside, or migrate draft to emit into the new table — prefer
**add alongside** to avoid touching working draft code in this phase).

- New table `notification`: `id`, `manager_id`, `league_id` (nullable),
  `type` (text/enum, extensible per phase), `channel` (`IN_APP` | `EMAIL`),
  `status` (`PENDING`|`SENT`|`FAILED`|`READ`), `title`, `body`, `link` (in-app
  deep link), `dedupe_key` (nullable, unique-per-manager to suppress repeats),
  `created_at`, `sent_at`, `read_at`.
- Service `src/data/notify/service.ts`: `enqueue(...)`, `markRead(...)`,
  `listForManager(...)`, `deliverPending(...)`. Email delivery reuses the
  existing Resend notifier wiring from `src/data/draft/resend-notifier.ts`
  (extract the transport into `src/data/notify/transport.ts` so both share it).
- A bell/inbox surface in the top nav (count of unread `IN_APP`).

### 0.2 Realtime feed helper
Extract the SSE poll+diff loop from the draft stream route into a reusable
helper so any surface can stream a serialized snapshot.

- `src/web/realtime/sse.ts`: `streamSnapshots({ getSnapshot, pollMs, signal })`
  returning a `text/event-stream` `Response`; emits on first connect and only
  when the serialized snapshot changes; includes the heartbeat comment.
- Refactor the draft stream route to use it (proves the extraction; keep
  behavior identical, `POLL_MS = 1500`).

### 0.3 Per-league feature flags
A simple, typed, league-scoped toggle store so commissioners opt into features.

- New table `league_feature_flag`: `league_id`, `flag` (text key), `enabled`
  (bool), `config` (jsonb, nullable for per-feature settings), PK
  `(league_id, flag)`.
- `src/data/league/feature-flags.ts`: typed `FLAGS` union (`'chat'`,
  `'head_to_head'`, `'bracket'`, `'survivor'`, `'chips'`, `'awards'`, ...),
  `getFlags(leagueId)`, `setFlag(...)`, with sane defaults (everything off
  except whatever you want on by default).
- A commissioner "League settings → Features" panel (owner-only) to toggle them.

### 0.4 Stats service layer + nav shell
A read-only aggregation layer the Stats Hub (Phase 1) and others build on,
plus the navigation entries.

- `src/data/stats/aggregate.ts`: typed helpers that load `score_entry` +
  `stat_line` + `fixture` for a stage or whole tournament and return in-memory
  shapes (top scorers, per-fixture player points, etc.). Keep it pure and
  bulk-query based, mirroring `standings.ts`.
- Add top-level nav entries (behind flags where relevant): **Stats**, and
  per-league tabs for the features that later phases fill in.

## Tasks
- [ ] Migration `0009_foundations.sql`: `notification`,
      `league_feature_flag` tables (+ indexes on `manager_id`/`status` and
      `league_id`).
- [ ] `src/data/notify/transport.ts` — extract Resend transport from the draft
      notifier; both notifiers use it.
- [ ] `src/data/notify/service.ts` + Vitest spec (enqueue, dedupe, deliver,
      markRead).
- [ ] In-app notification inbox: `GET /api/notifications`,
      `POST /api/notifications/[id]/read`, and a nav bell component.
- [ ] `src/web/realtime/sse.ts` helper; refactor draft stream route onto it
      with no behavior change.
- [ ] Migration columns + `src/data/league/feature-flags.ts` typed helper +
      spec.
- [ ] Owner-only "Features" settings panel + `GET/PUT` flags route.
- [ ] `src/data/stats/aggregate.ts` base helpers + spec.
- [ ] Nav shell: add Stats entry and per-league tab scaffolding.

## Acceptance criteria
- [ ] A feature can `enqueue` an in-app + email notification in one call; the
      bell shows unread count; marking read clears it; email sends via Resend.
- [ ] Draft stream route still behaves identically but now imports the shared
      SSE helper.
- [ ] `getFlags(leagueId)` returns typed defaults for a league with no rows;
      owner can toggle a flag and a gated component reacts.
- [ ] `aggregate.ts` returns correct top-scorer / per-fixture shapes verified
      by a spec against seeded data.
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Push/browser notifications (Phase 8 may add web push).
- Migrating `draft_notification` rows into the new table (optional later
  cleanup).

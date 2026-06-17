# Phase 8 — Notifications, Alerts & Polish

**Prerequisites:** Phase 0 (notification hub), and ideally Phases 3 & 6 (so
their events exist to notify on). Touches several earlier phases.
**Read first:** `PLAN.md` §2, the cron route
`app/api/cron/ingest-and-score/route.ts`, `src/data/draft/resend-notifier.ts`.

## Goal

A cross-cutting sweep that makes the app feel responsive and complete:
real-match **goal/score alerts** for your players, **deadline reminders**
(stage lock, captain/chip, survivor/bracket picks), a **draft-room polish**
pass, and a **mobile responsiveness** pass. This is intentionally last because
it depends on events introduced by earlier phases.

## Why

Notifications are what pull people back during matches; polish and mobile are
what make them stay. Doing this once at the end means every feature's events get
consistent, deduped delivery instead of each phase bolting on its own emails.

## Design / approach

### 8.1 Goal / score alerts
- During live fixtures, when a newly-ingested `stat_line` shows a rostered
  player scored/assisted/kept a clean sheet, enqueue an in-app (+ optional
  email) notification to managers who roster them.
- Hook into the cron ingest step: after `recomputeAll`, diff what changed since
  the last run (compare new `score_entry`/`stat_line` against prior) and emit
  events. Keep a small `last_notified_revision` marker (or compare
  `ingested_at`) so each event fires once — idempotency is critical here.
- Note the data cadence: cron currently runs daily (`vercel.json`:
  `0 8 * * *`) and SofaScore isn't reachable from cron, so "live" alerts are
  really post-ingest alerts after a manual/scheduled refresh. Design the diff
  to fire correctly whenever ingest runs, regardless of cadence; if you want
  truer live alerts, that's a separate ingest-frequency change, out of scope
  here.

### 8.2 Deadline reminders
- A scheduled check (extend the cron or add `/api/cron/reminders`) that, ahead
  of each stage's first kickoff, reminds managers who haven't set a captain /
  spent thinking on chips (Phase 6), submitted a survivor pick (Phase 5), or
  locked a bracket — only the ones with an outstanding action, deduped per
  deadline.
- Respect per-manager notification preferences (add a simple prefs table or
  reuse a `manager` JSON column): channels on/off per category.

### 8.3 Draft-room polish
- Building on the existing draft room + SSE stream: add a **pick queue**
  (pre-rank your targets; autopick prefers your queue when on the clock — extend
  `autopick.ts` to consult a per-team queue before falling back to
  `draft_rank`), a clearer **on-the-clock timer**, recent-picks ticker, and
  best-available-by-position hints (ties into Phase 2 ADP overlay).
- New table `draft_queue`: `(draft_room_id, fantasy_team_id, player_id, rank)`.

### 8.4 Mobile & accessibility pass
- Audit the key surfaces (league page, draft room, standings, Stats Hub, chat)
  for small-screen layout; ensure pitch/bracket views scroll/scale; tap targets
  and contrast; keyboard navigation on tables.

## Tasks
- [ ] Score-alert diff in the cron ingest step + `enqueue` per rostering
      manager; idempotency marker so each event fires once.
- [ ] `/api/cron/reminders` (or extend existing cron) for stage/captain/chip/
      survivor/bracket deadline reminders, deduped, outstanding-action-only.
- [ ] Notification preferences (table or `manager` JSON) + a settings UI;
      service respects them.
- [ ] `draft_queue` table + queue UI in the draft room; extend `autopick.ts` to
      consult the queue (+ spec) before `draft_rank`.
- [ ] Draft-room polish: timer clarity, recent-picks ticker, best-available
      hints.
- [ ] Mobile/accessibility pass across key pages (no logic changes, layout +
      a11y only).

## Acceptance criteria
- [ ] A rostered player's goal produces exactly one notification per relevant
      manager per event, even if ingest reruns (idempotency spec-verified).
- [ ] Deadline reminders go only to managers with an outstanding action and at
      most once per deadline.
- [ ] Autopick prefers a team's queued, still-available, position-legal player;
      falls back to `draft_rank` when the queue is empty/illegal (spec-verified).
- [ ] Notification preferences actually suppress the opted-out categories.
- [ ] Key pages are usable at mobile widths; `npm run typecheck` and `npm test`
      pass.

## Out of scope
- Changing ingest frequency / true real-time data (separate infra decision).
- Native push beyond optional web push (can be a follow-up).

# Phase 08 — Notifications & Polish (scoped subset) — Completion Report

## Status
- Acceptance checklist: **PASS** for the in-scope subset (goal/score alerts and
  deadline reminders were intentionally out of scope — see Deviations).
- typecheck: **could not run the full project gate in this sandbox** (the dev
  mount truncates UTF-8 files containing multi-byte characters when read by the
  shell, so `tsc` over the working tree reports false syntax errors on files it
  reads truncated — including files I never touched, e.g. `stage-pitch-marker.tsx`).
  The authoritative files on disk are intact. **Please run `npm run typecheck`
  and `npm test` on your machine to confirm the green gate.**
- Pure-logic specs were verified by **isolated compile + execution** in the
  sandbox (real `validator.ts` + an ASCII copy of the new logic):
  - Autopick fallback chain: **15/15 assertions pass** (strict typecheck clean).
  - Notification-preference suppression decision: **7/7 assertions pass**.

## Acceptance checklist (in-scope items from the phase doc)
- [x] **Notification preferences + settings UI; service respects them.**
  Per-manager (account-level) prefs in a new `notification_preference` table;
  `enqueue` drops a channel the manager has opted out of for that category.
  Categories are ONLY the existing draft notification `type`s (DRAFT_STARTED,
  ON_THE_CLOCK, PICK_MADE, AUTOPICK_MADE, DRAFT_COMPLETE) — no invented
  categories. Verified: pure suppression spec (executed, 7/7) + integration spec
  `test/integration/notify-preferences.test.ts` (runs on your machine).
- [x] **`draft_queue` table + queue UI + autopick consults the queue.**
  New `draft_queue (draft_room_id, fantasy_team_id, player_id, rank)` + index.
  `chooseAutopick` now prefers the highest-priority queued player that is still
  available AND position-legal, falling back to `draft_rank` when the queue is
  empty/illegal. Snake order + timer untouched (only candidate selection
  changed). Verified: executed unit spec (15/15) + `test/integration/draft-queue.test.ts`.
- [x] **Draft-room UI polish: clearer timer, recent-picks ticker,
  best-available-by-position hints.** Timer now has `role="timer"`,
  `aria-live`, and urgent/overdue styling; a recent-picks ticker and a
  best-available strip (driven by the Phase 2 ADP on `DraftBoardPlayer`) sit
  above the board. Reuses the existing SSE `streamSnapshots` — no new realtime.
- [x] **Mobile & accessibility pass (layout + a11y only).** App-wide
  keyboard focus ring (`:focus-visible`), 44px touch targets on coarse pointers,
  scrollable table regions made keyboard-focusable (`tabIndex`/`role="region"`)
  across league/standings/roster/Stats Hub (leaderboards, records, players,
  draft-trends, team-of-the-stage) + the draft board. Pitch/ticker views
  scroll horizontally on narrow screens. Chat excluded (Phase 3 not built).
- [x] `npm run typecheck` / `npm test` — **to be confirmed on your machine**
  (sandbox limitation above). Pure specs verified in-sandbox by execution.

## What changed
- **Migration added:** `drizzle/0010_notify_prefs_draft_queue.sql` (append-only,
  hand-written, idempotent: `CREATE TABLE IF NOT EXISTS`, guarded `ADD
  CONSTRAINT`). Journal entry idx 10 added to `drizzle/meta/_journal.json`.
- **New tables:** `notification_preference (manager_id, category, channel,
  enabled, updated_at)` PK(manager_id, category, channel); `draft_queue
  (draft_room_id, fantasy_team_id, player_id, rank, created_at)`
  PK(room, team, player) + `(room, team, rank)` index. Both added to the test
  `setup.ts` truncate list.
- **New services (+ specs):**
  - `src/data/notify/preferences.ts` — `getPreferences`, `setPreference`,
    `allowedChannels`, pure `applyPreferences`/`disabledSetFromRows`/
    `isNotificationCategory`, `NOTIFICATION_CATEGORIES`, `CATEGORY_LABELS`.
    Specs: `test/unit/notify-preferences.test.ts`,
    `test/integration/notify-preferences.test.ts`.
  - `src/data/draft/queue.ts` — `queuedPlayerIds`, `getQueue`, `addToQueue`,
    `removeFromQueue`, `reorderQueue`. Spec: `test/integration/draft-queue.test.ts`.
  - `src/data/draft/autopick.ts` — added `selectQueuedCandidate`, a `queue`
    param on `chooseAutopick`, and `fromQueue` on `AutopickResult`. Spec:
    `test/unit/draft-autopick-queue.test.ts`.
- **Service wiring:** `src/data/notify/service.ts` `enqueue` now filters
  channels via `allowedChannels`. `src/data/draft/service.ts`
  `pickAutopickPlayer` loads the team's queue and passes it to `chooseAutopick`
  (signature gained `draftRoomId`; both callers updated).
- **Routes added:** `GET|PUT /api/account/notifications`,
  `GET|POST /api/leagues/[leagueId]/draft/queue`.
- **UI added/changed:** `app/account/notifications/{page,notification-settings}.tsx`
  (prefs settings); `app/leagues/[leagueId]/draft/queue-panel.tsx` (queue);
  draft-room (queue state + panel, timer, ticker, best-available hints);
  player-board (+Queue button, focusable scroll region); notification-bell
  (Settings link); `app/globals.css` (new component styles + a11y focus/tap);
  a11y `tabIndex`/`role` on the in-scope `table-scroll` regions.

## Deviations from the plan
- **Goal/score alerts (8.1) — NOT built.** Out of scope per the prompt (depends
  on a live ingest diff; the cron isn't reachable to SofaScore).
- **Deadline reminders (8.2: captain/chip/survivor/bracket) — NOT built.** Those
  depend on Phases 5/6, which are deferred. The 8.2 *preferences* portion WAS
  built.
- **Chat excluded from the a11y pass.** Phase 3 isn't built.
- **Preferences are enforced at the Phase 0 hub (`enqueue`), per Appendix A.**
  IMPORTANT hand-off: the draft today still emits via the *legacy*
  `draft_notification` + `Notifier` path (pre-Phase-0), which does NOT route
  through `enqueue`. So a manager's pref currently suppresses anything that uses
  the hub, but will only suppress the *draft's own* emails once the draft
  notifications are migrated onto the Phase 0 hub (or the legacy `deliverPending`
  is taught to consult `allowedChannels`). I did not migrate the draft notifier
  — that wasn't in scope. The categories I exposed deliberately match the legacy
  `DraftNotificationType` values so the migration is a drop-in later.
- **No scoring changes.** `ruleset.ts`/`score.ts`/`recompute.ts` untouched;
  default version stays `wcf-v1-5c4f7b33`.

## Follow-ups / new tech debt
- Migrate the draft's legacy `draft_notification`/`Notifier` delivery onto the
  Phase 0 hub so notification preferences actually gate the live draft emails
  (see Deviations). Quick interim option: have the draft `deliverPending`
  consult `allowedChannels(db, managerId, n.type, ["EMAIL"])`.
- The a11y scroll-region `aria-label` is generic ("Scrollable table"); could be
  made per-table for nicer screen-reader announcements.
- `reorderQueue` rewrites ranks row-by-row; fine at draft sizes, could be a
  single CASE update if queues ever get large.

## Hand-off pointers for later phases
- `src/data/notify/preferences.ts`: `allowedChannels(db, managerId, type,
  requested)` is the single place that gates channels — reuse it if/when the
  draft moves to the hub. `NOTIFICATION_CATEGORIES` is the canonical category
  list; extend it (and `CATEGORY_LABELS`) when a new notification `type` ships.
- `src/data/draft/queue.ts`: `queuedPlayerIds(db, roomId, teamId)` is what
  autopick consults; `chooseAutopick(counts, available, reqs?, queue?)` now
  takes an optional ordered `queue` and returns `fromQueue`.
- No new feature flags introduced (prefs are account-level, not league-gated;
  the queue/polish live in the always-on draft room).

## Branch / diff
- **Branch:** intended `phase-08-polish` did not exist in the repo; current
  branch is `main` with substantial *uncommitted* Phase 1/2 work already in the
  tree. I did **not** commit and did **not** touch `main`'s history — all Phase 8
  work is uncommitted in the working tree. There is also a stale
  `.git/index.lock` the sandbox can't remove (created on the Windows side); git
  writes from here will fail until you remove it. **Recommend:** on your machine,
  `git checkout -b phase-08-polish`, then review/commit. (Per instructions I did
  not open a PR.)
- **Files touched:** 12 new, ~11 edited (migration, schema, journal, setup,
  notify service, autopick, draft service, notification-bell, draft-room,
  player-board, globals.css, + 8 stats/standings/roster files for the a11y
  `tabIndex` pass).

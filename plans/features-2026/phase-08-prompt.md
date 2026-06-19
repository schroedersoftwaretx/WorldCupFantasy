# Phase 8 — Notification Prefs + Draft-Room Polish & Mobile/A11y — ready-to-paste prompt

Scope for this hand-off (a deliberate SUBSET of Phase 8, chosen because phases 3,
5, and 6 are deferred):
- **Notification preferences** (8.2, prefs portion only): per-manager prefs +
  settings UI + the notify service respects them.
- **Draft-room pick queue + autopick** (8.3): `draft_queue` table, queue UI,
  autopick consults the queue before `draft_rank`.
- **Draft-room UI polish** (8.3): clearer on-the-clock timer, recent-picks ticker,
  best-available-by-position hints (builds on the Phase 2 ADP overlay).
- **Mobile & accessibility pass** (8.4) across BUILT surfaces.

DELIBERATELY EXCLUDED (do not build): goal/score alerts (8.1); stage/captain/chip
deadline reminders (Phase 6), survivor/bracket reminders (Phase 5); anything that
touches chat/activity (Phase 3) or head-to-head (Phase 4).

## Orchestrator pre-flight (do these first)
- [ ] Phases 0, 1, and 2 are merged to `main`. (Phase 7 is independent; not
      required.) Build from current `main`.
- [ ] `npm run typecheck` and `npm test` are green on `main`.
- [ ] This scope ADDS a migration: the next number is `0010_*.sql` (latest applied
      is `0009_foundations.sql`).
- [ ] `git checkout -b phase-08-polish` from up-to-date `main`.

---

## COPY BELOW THIS LINE → paste as the new agent's first message

You are implementing a SUBSET of one phase of the World Cup Fantasy feature
roadmap: **Phase 8 — Notification preferences + draft-room polish + mobile/a11y.**
Several Phase 8 ideas depend on features that are NOT built; build only the parts
listed under Scope and skip the rest.

Read these before writing any code, in order:
1. `plans/features-2026/PLAN.md` — architecture, conventions, the scoring spine
   you must not touch, and **Appendix A** (Phase 0 notify hub: `enqueue`,
   `listForManager`, transports), **Appendix C** (Phase 2: `DraftBoardPlayer` now
   carries `adp` — the draft-board overlay you will extend for best-available
   hints). Note §1.5 (migrations are HAND-WRITTEN + idempotent — NEVER
   `drizzle-kit generate` / `npm run migrate:generate`) and §5 (specs in `test/`,
   services `db`-first).
2. `plans/features-2026/phase-08-notifications-polish.md` — the phase doc. Build
   ONLY sections 8.2 (preferences portion), 8.3, and 8.4 as scoped below. Also
   read `src/data/draft/autopick.ts` (`chooseAutopick`, `legalAutopickCandidates`,
   `selectBestCandidate`), the draft SSE route
   `app/api/leagues/[leagueId]/draft/stream/route.ts`, the draft board
   `player-board.tsx`, and `src/data/notify/service.ts`.

Scope — build exactly this:
- **Notification preferences.** Add per-MANAGER (account-level, not league-level)
  notification prefs — a `notification_preference` table or a JSONB column on
  `manager` (your call; hand-written idempotent migration either way). A settings
  UI lets a manager toggle channels (IN_APP / EMAIL) per category. The notify
  service respects them: `enqueue` (or delivery) skips a channel the manager has
  opted out of. IMPORTANT: categories are ONLY the notification `type`s that
  already exist today (e.g. draft pick / on-the-clock / draft started). Do NOT
  invent categories for unbuilt features (no goal alerts, chips, survivor, chat).
- **Draft-room pick queue + autopick.** New table `draft_queue`
  `(draft_room_id, fantasy_team_id, player_id, rank)` (+ index). Queue UI in the
  draft room to add/remove/reorder targets. Extend `autopick.ts` so that when a
  team is auto-picked it prefers its queued, STILL-AVAILABLE, POSITION-LEGAL
  player (highest queue rank first), falling back to the existing `draft_rank`
  logic when the queue is empty or yields no legal pick. Do NOT change the snake
  pick order or timer mechanics — only candidate selection. Spec-verify the
  fallback chain.
- **Draft-room UI polish.** Clearer on-the-clock timer, a recent-picks ticker, and
  best-available-by-position hints driven by the existing Phase 2 ADP data on
  `DraftBoardPlayer` (Appendix C). Reuse the existing SSE stream
  (`streamSnapshots`); do not add a new realtime mechanism.
- **Mobile & accessibility pass.** Layout + a11y only (no logic changes) across the
  BUILT surfaces: league page, draft room, standings, roster/team page, and the
  Stats Hub (incl. Draft Trends, and the Trophy Room if Phase 7 has merged).
  Ensure pitch views scroll/scale, tap targets and contrast are adequate, and
  tables are keyboard-navigable. EXCLUDE chat (Phase 3 is not built).

Hard rules:
- Implement ONLY the scope above. Do NOT build goal/score alerts, deadline
  reminders, or anything tied to chat/activity (Phase 3), head-to-head (Phase 4),
  survivor/bracket (Phase 5), or chips/captain (Phase 6). If a piece of the phase
  doc references those, skip it and note it in your report.
- New migration is `0010_*.sql`, HAND-WRITTEN + idempotent (`CREATE TABLE IF NOT
  EXISTS`, guarded `ADD COLUMN`/`CREATE TYPE`); add its `_journal.json` entry; add
  any new table to the test `setup.ts` truncate list. Never edit an existing
  migration; never run drizzle-kit.
- Do NOT modify `ruleset.ts` / `score.ts` / `recompute.ts` — no scoring changes in
  this phase. The default ruleset version stays `wcf-v1-5c4f7b33`.
- Reuse Phase 0 exactly (Appendix A) for notifications; reuse the existing draft
  SSE stream and Phase 2 ADP for the draft polish.
- Pure services in `src/data/**` with Vitest specs in `test/`; thin route/component
  adapters; `db`-first signatures.

Workflow:
- Work on the current branch (`phase-08-polish`); do not commit to `main`.
- Keep `typecheck` and tests green; add specs in `test/`. Spec-verify: opted-out
  categories are suppressed; autopick prefers a queued/legal/available player and
  falls back to `draft_rank` when the queue is empty or illegal.
- When done, produce the Completion Report using the template in
  `plans/features-2026/HANDOFF.md`, including a "Deviations from the plan" section
  that lists the Phase 8 items intentionally left out (goal alerts, deadline
  reminders, chat in the a11y pass). Do not merge or open a PR unless asked.

Begin by reading the docs (Appendices A and C) and confirming the prerequisites:
`src/data/notify/service.ts` exports `enqueue`; `src/data/draft/autopick.ts`
exports `chooseAutopick`; `DraftBoardPlayer` carries `adp`.

## COPY ABOVE THIS LINE

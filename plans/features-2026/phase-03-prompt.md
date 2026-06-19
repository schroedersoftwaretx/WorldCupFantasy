# Phase 3 — Social (Chat, Activity Feed, Recaps) — ready-to-paste agent prompt

Scope for this hand-off: **FULL Phase 3** — league chat (reactions, GIF-by-URL,
SSE, in-app notifications, mute) + activity feed + auto recaps & power rankings
hooked into the post-stage recompute.

## Orchestrator pre-flight (do these first)
- [ ] Phases 0, 1, 2 are merged to `main` as a known-good baseline (Phase 3
      depends only on Phase 0's notify hub + SSE helper + feature flags, but build
      from current `main`).
- [ ] `npm run typecheck` and `npm test` are green on `main`.
- [ ] `npm run migrate` is up to date (latest applied is `0009_foundations.sql`);
      Phase 3 adds the NEXT migration `0010_social.sql`.
- [ ] `git checkout -b phase-03-social` from up-to-date `main`.

---

## COPY BELOW THIS LINE → paste as the new agent's first message

You are implementing ONE phase of the World Cup Fantasy feature roadmap:
**Phase 3 — Social: Chat, Activity Feed, Auto Recaps & Power Rankings (the FULL
phase).**

Read these before writing any code, in order:
1. `plans/features-2026/PLAN.md` — architecture, conventions, the scoring spine
   you must not break, and **Appendix A** (Phase 0 as-built APIs you will import:
   notify `enqueue`, the SSE helper `streamSnapshots`, the `FLAGS` /
   `isFlagEnabled` / `setFlag` feature-flag API). Note especially §1.5 (migrations
   are HAND-WRITTEN and idempotent — NEVER `drizzle-kit generate` /
   `npm run migrate:generate`) and §5 (specs go in `test/`, services are
   `db`-first).
2. `plans/features-2026/phase-03-social.md` — the phase you will implement. Also
   read the existing draft SSE route
   `app/api/leagues/[leagueId]/draft/stream/route.ts` (the canonical
   `streamSnapshots` usage to mirror) and `src/data/standings/snapshot.ts`
   (`captureStandingsSnapshots`, `getSnapshotRanks`, `managerOfStage`,
   per-stage rank — power-ranking movement = diff of consecutive
   `standings_snapshot` rows).

Scope — build all three pieces:
- 3.1 **League chat**: migration tables `chat_message` (soft-delete via
  `deleted_at`, index `(league_id, created_at)`) + `chat_reaction`
  (`(message_id, manager_id, emoji)` PK). Service `src/data/social/chat.ts`
  (post / edit / soft-delete / paginated list / toggle reaction; membership-gated).
  Routes `POST|GET /api/leagues/[id]/chat`, a reaction route, and SSE
  `GET /api/leagues/[id]/chat/stream` via `streamSnapshots` (`pollMs ~= 2500`).
  Chat panel UI on the league page: render reactions, render image/GIF URLs
  inline (NO upload pipeline — paste-a-link only), per-member mute toggle. A new
  message enqueues IN_APP notifications to other non-muted members, deduped under
  burst (use a `dedupeKey`).
- 3.2 **Activity feed**: table `activity_event` (`id`, `league_id`, `type`,
  `payload` jsonb, `created_at`). Prefer WRITING events for new features; PROJECT
  already-logged ones (draft picks from `draft_pick`, rank changes from
  `standings_snapshot`) on read. Feed route + UI tab (interleaved with chat or its
  own tab).
- 3.3 **Auto recaps & power rankings**: pure `src/data/social/recap.ts` that takes
  a stage's computed standings/scores and returns a deterministic structured recap
  (power rankings with movement vs previous stage; "biggest blowout", "top haul",
  "narrowly missed XI" — best-ball auto-optimizes so frame the bench item that
  way — "manager of the stage"). NO external LLM dependency; deterministic
  templated copy must stand alone. Hook generation into the post-stage recompute:
  in `app/api/cron/ingest-and-score/route.ts`, right AFTER `recomputeAllRulesets`
  + `captureAllStandingsSnapshots`. Auto-post the recap into chat + activity and
  notify members. Make it IDEMPOTENT — once per league per stage, safe if the cron
  reruns.

Hard rules:
- Implement ONLY Phase 3. Do NOT start Phase 4. Stop when the phase's acceptance
  checklist is fully satisfied and `npm run typecheck` + `npm test` are green.
- **Gate the whole feature behind the `chat` feature flag** (already in `FLAGS`).
  Routes and the panel check `isFlagEnabled(db, leagueId, "chat")`; non-members
  get 403 regardless of the flag.
- Reuse Phase 0 EXACTLY (Appendix A) — do not re-derive notify / SSE / flags.
  Notifications go through `enqueue(db, { managerId, type, title, body, leagueId,
  link?, channels?, dedupeKey? })`; chat notifications are IN_APP only.
- Migration is HAND-WRITTEN + idempotent, named `0010_social.sql` (`CREATE TABLE
  IF NOT EXISTS`, guarded `CREATE TYPE`); add its `_journal.json` entry. Keep the
  generated `0010_snapshot.json` only if you produce it manually — do NOT run
  drizzle-kit. Never edit an existing migration. Add the new tables to the test
  `setup.ts` truncate list.
- Do not break the `stat_line -> score_entry -> standings` spine. Derive what can
  be derived (project draft picks / rank changes); store only genuinely new events.
- Pure services in `src/data/social/**` with Vitest specs in `test/`. Thin route/
  component adapters. `db`-first signatures. Recap generation must be a pure,
  spec-tested function separate from the posting/notify side effects.

Workflow:
- Work on the current branch (`phase-03-social`); do not commit to `main`.
- Keep `typecheck` and tests green; add a spec in `test/` alongside each pure
  service. Spec-verify: power-ranking movement equals the snapshot diff; the recap
  object is deterministic for a fixed input; auto-post is idempotent across reruns.
- When done, produce the Completion Report using the template in
  `plans/features-2026/HANDOFF.md`, including a "Deviations from the plan"
  section. Do not merge or open a PR unless asked — just report.

Begin by reading the two docs (including Appendix A) and confirming Phase 0 is in
place (`src/data/notify/service.ts` exports `enqueue`; `src/web/realtime/sse.ts`
exports `streamSnapshots`; `FLAGS` includes `chat`).

## COPY ABOVE THIS LINE

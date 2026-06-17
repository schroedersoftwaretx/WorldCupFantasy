# Phase 1 — Stats Hub — ready-to-paste agent prompt

Scope for this hand-off: **FULL Phase 1** — Team of the Matchday/Stage +
tournament leaderboards + records.

## Orchestrator pre-flight (do these first)
- [ ] `npm run migrate` has been run so `0009_foundations.sql` is applied on the DB.
- [ ] Phase 0 is committed on `main` as a known-good baseline (see Cleanup below).
- [ ] `git checkout -b phase-01-stats-hub` from up-to-date `main`.

## Cleanup carried over (confirm done)
- [ ] Phase 0's 35 changed/new files committed (nothing was committed yet).
- [ ] `INTEGRATION_DATABASE_URL` in `.env` is disabled (done — it pointed at prod).
- [ ] Optional tech debt, not blocking: regenerate stale drizzle meta snapshots
      for `0006`-`0008` so future `drizzle-kit` diffs are tight (Phase 0 follow-up).

---

## COPY BELOW THIS LINE → paste as the new agent's first message

You are implementing ONE phase of the World Cup Fantasy feature roadmap:
**Phase 1 — Stats Hub & Team of the Matchday (the FULL phase).**

Read these before writing any code, in order:
1. `plans/features-2026/PLAN.md` — architecture, conventions, the scoring spine
   you must not break, and **Appendix A** (Phase 0 as-built APIs you will
   import). Note especially §1.5 (migrations are HAND-WRITTEN and idempotent —
   NEVER `drizzle-kit generate` / `npm run migrate:generate`) and §5 (specs go
   in `test/`, services are `db`-first).
2. `plans/features-2026/phase-01-stats-hub.md` — the phase you will implement.

Scope — build all three pieces:
- 1.1 **Team of the Matchday/Stage**: reuse `optimizeBestBall` from
  `src/data/standings/lineup.ts` over the GLOBAL player pool for a stage (not a
  single roster) to get the best legal XI. New service
  `src/data/stats/team-of-the-stage.ts` + spec.
- 1.2 **Tournament leaderboards**: extend `src/data/stats/aggregate.ts`
  (`topScorers` / `perFixturePlayerPoints` / `statLeaders` already exist — see
  Appendix A) for per-position and form; build the best-single-match-haul query
  here (Phase 7 reuses it).
- 1.3 **Records / fun stats** section.
- 1.4 Public pages under `app/`, `GET /api/stats/*` routes, optional memoized
  cache keyed on the latest `score_entry.computedAt`.

Hard rules:
- Implement ONLY Phase 1. Do NOT start Phase 2. Stop when the phase's acceptance
  checklist is fully satisfied and `npm run typecheck` + `npm test` are green.
- The Stats Hub is PUBLIC (no login). The `stats_hub` feature flag only controls
  per-league nav visibility — do not gate the pages behind it.
- Pure services in `src/data/stats/**` with Vitest specs in `test/`. Thin route/
  component adapters. `db`-first signatures. Reuse the Phase 0 APIs from
  Appendix A — do not re-derive notify / sse / flags / aggregate.
- Phase 1 is read-only over existing tables, so you most likely need NO
  migration. If you genuinely do, it must be hand-written + idempotent (`0010_*`)
  per §1.5 — confirm the need first.
- Follow the derived-not-stored philosophy (mirror `score_entry`): compute in
  pure functions, cache only if you measure a need.

Workflow:
- Work on the current branch (`phase-01-stats-hub`); do not commit to `main`.
- Keep `typecheck` and tests green; add a spec in `test/` alongside each pure
  service.
- When done, produce the Completion Report using the template in
  `plans/features-2026/HANDOFF.md`, including a "Deviations from the plan"
  section. Do not merge or open a PR unless asked — just report.

Begin by reading the two docs (including Appendix A) and confirming Phase 0 is in
place (`src/data/stats/aggregate.ts` exports `topScorers` / `statLeaders`).

## COPY ABOVE THIS LINE

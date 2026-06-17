# Phase 1 — Stats Hub & Team of the Matchday

**Prerequisites:** Phase 0 — shipped on `main` (stats aggregate layer, nav
shell, feature flags). Import the **as-built signatures in PLAN.md Appendix A**,
not the prose shorthand in this doc.
**Read first:** `PLAN.md` §1.5 (hand-written migrations — never drizzle-kit
generate), §5 (specs in `test/`, db-first services), §2 (scoring spine), and
Appendix A; then `src/data/standings/lineup.ts` and `src/data/stats/aggregate.ts`.

**Flag note:** Phase 0 added a `stats_hub` feature flag. The Stats Hub itself
stays **publicly reachable** (no login); the flag governs only whether a league's
nav surfaces a link to it. Do NOT gate the pages behind the flag.

**Migration note:** Phase 1 is read-only over existing tables, so you most
likely need NO new migration — confirm before adding one.

## Goal

A tournament-wide **Stats Hub** — public, not league-specific — that surfaces
interesting cross-tournament stats, headlined by the **Team of the Matchday /
Stage**: the single best-scoring legal XI from *all* real players for a given
scoring period.

## Why

This is high-value and low-risk: it's almost entirely **reads** over the
existing `stat_line` / `score_entry` spine, with no new writes or scoring
changes. It gives every visitor (not just league members) a reason to return
during the tournament and showcases the data you already collect.

## Design / approach

### 1.1 Team of the Matchday/Stage
Reuse the best-ball optimizer in `src/data/standings/lineup.ts`, but run it over
the **global player pool** for a stage instead of one roster.

- New service `src/data/stats/team-of-the-stage.ts`: for a given `stage`, load
  every player's `score_entry` for that stage's fixtures, then call the existing
  `optimizeBestBall` over the full pool to get the highest-scoring legal XI
  (1 GK + the four legal formations). Return XI, formation label, total, and
  each player's points + key stat line.
- Because the optimizer already enumerates `LEGAL_FORMATIONS` and is pure, this
  is mostly a data-loading wrapper — call out and reuse it, don't re-implement.
- Render as a pitch view (reuse the draft `best-lineup.tsx` pitch component if
  one exists; otherwise a simple formation grid).

### 1.2 Tournament leaderboards
Built on `src/data/stats/aggregate.ts` from Phase 0:
- Top fantasy scorers (overall and per position).
- Real-stat leaders: goals, assists, clean sheets, saves, minutes.
- "Form" — points over the last N fixtures a player featured in.
- Best single-match hauls (highest `score_entry.points` rows) — this also feeds
  Phase 7 awards; build the query here, reuse there.

### 1.3 Records & fun stats
A "records" section computed on demand:
- Highest-scoring XI of the tournament so far.
- Biggest single-player matchday.
- Most goals by one nation's players, etc.
- Position scarcity heatmap (avg points by position by stage) — useful and
  cheap.

### 1.4 Surfaces & caching
- New routes under `app/(stats)/stats/...` (public): `/stats`, `/stats/team-of-
  the-stage/[stage]`, `/stats/leaderboards`.
- Read routes `GET /api/stats/...` returning the aggregate shapes.
- These reads are heavier than a single league; if a stage page is slow, cache
  the computed payload keyed by `(stage, latest score_entry computedAt)` —
  follow the derived-not-stored principle, only cache after measuring.

## Tasks
- [ ] `src/data/stats/team-of-the-stage.ts` (+ spec) reusing `optimizeBestBall`.
- [ ] Extend `src/data/stats/aggregate.ts` with leaderboard + records queries
      (+ specs).
- [ ] `GET /api/stats/team-of-the-stage/[stage]`, `/api/stats/leaderboards`,
      `/api/stats/records`.
- [ ] Public Stats Hub pages: landing, Team of the Stage pitch view, leaderboard
      tables with position/stat filters, records section.
- [ ] Stage selector (the 9 `stageEnum` periods) with sensible default =
      latest stage that has any `score_entry`.
- [ ] Optional memoized cache layer keyed on latest `computedAt`.

## Acceptance criteria
- [ ] For any stage with stats, the page shows a legal XI whose total equals the
      max achievable from the global pool (verified by a spec against seeded
      data, including a formation-boundary case).
- [ ] Leaderboards match hand-computed totals from seeded `stat_line`.
- [ ] Stats Hub is reachable without being in a league (public).
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- League-relative stats (those live in Phase 2 / per-league pages).
- Awards persistence (Phase 7).

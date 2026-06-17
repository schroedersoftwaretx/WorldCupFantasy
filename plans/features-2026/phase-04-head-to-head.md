# Phase 4 — Head-to-Head & Rivalries

**Prerequisites:** Phase 0 (feature flags). Reads Phase 1 stats if present.
**Read first:** `PLAN.md` §2 (best-ball, scoring periods),
`src/data/standings/standings.ts` and `lineup.ts`.

## Goal

Offer an optional **head-to-head** format layered on top of best-ball: each
scoring period (stage), two teams' best-ball XI totals are compared as a
"match", producing a W/D/L record and an H2H standings table alongside the
existing cumulative-points table. Plus lightweight **rivalry** tracking.

## Why

H2H and rivalries add weekly stakes and narrative even when someone is out of
the overall lead — a manager mid-table can still "win their matchup". It reuses
the best-ball period totals you already compute, so the scoring is free; the new
work is scheduling and presentation.

## Design / approach

### 4.1 Schedule generation
- The 9 stages are the "weeks". Generate a round-robin schedule mapping each
  stage to a set of pairings among the league's fantasy teams (circle method;
  handle odd team counts with a bye). For >9 teams not everyone meets — that's
  fine; aim for a balanced partial round-robin across the 9 stages.
- Table `h2h_schedule`: `id`, `league_id`, `stage`, `home_team_id`,
  `away_team_id`. Generated once when H2H is enabled (and regenerable by the
  owner before the tournament starts; lock after the first stage finalizes).

### 4.2 Match results (derived)
- Do **not** store results. A pure `src/data/h2h/results.ts` reads each team's
  best-ball period total for the stage (reuse the standings/lineup services) and
  decides W/D/L per pairing. The H2H standings (points e.g. 3/1/0, then total
  fantasy points as tiebreak) are a pure read — same philosophy as `standings`.
- `src/data/h2h/standings.ts`: aggregate records across finalized stages.

### 4.3 Matchup pages & rivalries
- A per-stage "Matchups" view: the pairings, each side's best-ball XI and total,
  live-ish via projections for not-yet-finished stages (reuse
  `projected_score_entry`).
- "Rivalry" = cumulative H2H record between any two managers across the season
  (and across past seasons if you keep history later). Show on each matchup and
  on team pages ("you lead Alex 2-1").
- An "H2H mode" league can either run **alongside** points standings (default)
  or be the primary standings — a feature-flag `config` choice.

## Tasks
- [ ] Migration `00NN_h2h.sql`: `h2h_schedule` (+ unique
      `(league_id, stage, home, away)` and index on `league_id`).
- [ ] `src/data/h2h/schedule.ts` (+ spec): round-robin generation, odd-count
      byes, determinism.
- [ ] `src/data/h2h/results.ts` + `standings.ts` (+ specs): derived W/D/L and
      H2H table reusing best-ball period totals.
- [ ] Routes: generate/regenerate schedule (owner), `GET` matchups for a stage,
      `GET` H2H standings, `GET` rivalry between two teams.
- [ ] UI: Matchups tab (per stage), H2H standings table, rivalry badges on team
      pages.
- [ ] Feature flag `head_to_head` with `config.primaryStandings` boolean.
- [ ] Emit an `activity_event` (Phase 3) when a matchup finalizes, if social is
      enabled.

## Acceptance criteria
- [ ] Schedule is a valid balanced (partial) round-robin over 9 stages with
      correct byes for odd counts (spec-verified, deterministic).
- [ ] Match results and H2H table are pure functions of best-ball period totals
      and match hand-computed expectations on seeded data.
- [ ] Rivalry record between two teams equals the sum of their head-to-head
      finalized stages.
- [ ] Regeneration is blocked once the first stage has finalized.
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Playoffs/bracket among fantasy teams (could be a later add).
- Cross-season rivalry history (needs a season concept first).

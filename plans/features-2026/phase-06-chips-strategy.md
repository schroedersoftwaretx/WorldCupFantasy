# Phase 6 — Chips & Strategic Layer (best-ball-adapted)

**Prerequisites:** Phase 0 (flags, notifications). Touches the scoring read path.
**Read first:** `PLAN.md` §2-3, `src/data/standings/lineup.ts`,
`standings.ts`, `src/data/scoring/ruleset.ts`.

## Goal

Add an optional strategic layer of **chips** and a **per-stage captain** on top
of best-ball — the FPL-style "one-time power-up" hook — **without** mutating the
immutable scoring spine. Chips are an *overlay applied at standings-read time*,
not a change to `score_entry`.

## Why

Chips create agonizing strategic decisions ("do I use my Triple Captain on the
Final?") and give managers active choices in a format that is otherwise
set-and-forget. Adapting FPL's chips to best-ball is the interesting design work,
captured below.

## Key adaptation: best-ball has no captain/bench/transfers

FPL's chips assume a manual lineup. This league auto-fields the best XI from 23.
So translate, don't copy:

- **Per-stage captain (new optional layer).** Before a stage locks, a manager
  may nominate one rostered player as captain for that stage; that player's
  stage points are multiplied (default x2). This is the hook several chips build
  on. If a manager makes no pick, default to no captain (or auto-captain their
  projected top scorer — make it a flag).
- **Triple Captain** → captain multiplier becomes x3 for one chosen stage.
- **Bench Boost** → for one stage, score *all 23* rostered players' points
  instead of just the best XI (best-ball already uses the best XI, so this
  rewards roster depth).
- **Stage Boost (replaces Wildcard, since there are no transfers)** → double the
  team's entire best-ball total for one chosen stage. High-risk timing call.
- **Hindsight / "Crystal Ball" (optional)** → a low-power chip that lets a
  manager retroactively swap one auto-XI choice; mostly cosmetic given best-ball
  optimizes anyway — include only if you want a 4th chip.

Each chip is usable **once per tournament**, must be committed **before the
stage locks** (first kickoff of that stage), and is visible to the league after
lock for banter.

## Design / approach

### 6.1 Data
- Table `stage_captain`: `(league_id, fantasy_team_id, stage)` →
  `player_id`, `multiplier` (default 2), `locked_at`.
- Table `chip_play`: `id`, `league_id`, `fantasy_team_id`, `chip`
  (`TRIPLE_CAPTAIN`|`BENCH_BOOST`|`STAGE_BOOST`|...), `stage`, `created_at`,
  with a unique `(league_id, fantasy_team_id, chip)` (one use each) and a
  unique `(league_id, fantasy_team_id, stage)` if you forbid stacking two chips
  on one stage (recommended).

### 6.2 Overlay at read time (do not touch `score_entry`)
- Add `src/data/standings/overlay.ts`: given a team's raw per-stage best-ball
  result plus its captain/chip selections, return the *adjusted* stage total.
  The standings service composes: `rawPeriodTotal → applyCaptain → applyChips`.
- This keeps `score_entry` immutable and recomputable; the overlay is a pure
  function layered in `standings.ts` and the H2H/recaps consumers. Every surface
  that totals a stage must go through the overlay so numbers stay consistent.
- Deadlines enforced in the service: selections lock at first kickoff of the
  stage; after that they're immutable.

### 6.3 UX
- A "Chips & Captain" panel on the team page: pick captain per upcoming stage,
  spend a chip, see remaining chips. Show projected impact using
  `projected_score_entry`.
- Lock reminders via Phase 0 notifications; reveal selections to the league
  after lock (and emit an `activity_event`).

## Tasks
- [ ] Migration `00NN_chips.sql`: `stage_captain`, `chip_play` (+ uniqueness).
- [ ] `src/data/chips/service.ts` (+ spec): set captain, play chip, deadline
      enforcement, one-use & no-stack rules.
- [ ] `src/data/standings/overlay.ts` (+ spec): pure captain/chip application.
- [ ] Wire the overlay into `standings.ts` (and H2H results, recaps) so every
      stage total reflects chips consistently.
- [ ] Routes: set captain, play chip, get a team's chip/captain state.
- [ ] "Chips & Captain" UI panel with projected impact; lock reminders +
      post-lock reveal.
- [ ] Feature flag `chips` (+ `config` for multipliers / which chips are on).

## Acceptance criteria
- [ ] `score_entry` is never written by this phase; toggling chips off restores
      identical standings (spec-verified).
- [ ] Captain x2/x3 and Bench Boost/Stage Boost produce the hand-computed
      adjusted totals on seeded data, applied consistently in standings and H2H.
- [ ] Each chip is usable exactly once; selections are immutable after the stage
      locks; no two chips stack on one stage (if that rule is enabled).
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Mid-stage substitutions (best-ball auto-optimizes).
- Trades/free agents.

# Phase 5 — Side-games: Bracket Predictor & Survivor

**Prerequisites:** Phase 1 (stage data, results), Phase 0 (flags, notifications).
**Read first:** `PLAN.md` §2, `src/data/db/schema.ts` (`fixture`, `stage_odds`,
`national_team`).

## Goal

Two optional side-games that run parallel to the main fantasy league and keep
people engaged even if their roster is struggling:
1. **Knockout bracket predictor** — predict who advances through R32→Final.
2. **Survivor pool** — each round pick one nation you think wins; can't reuse a
   nation; one wrong pick (or you can allow N lives) and you're out.

## Why

Side-games broaden engagement and are a natural fit for a World Cup's knockout
structure. They reuse fixtures, stages, and results you already track, and they
give a second scoreboard to chase.

## Design / approach

### 5.1 Bracket predictor
- A manager fills in their predicted bracket before the knockouts lock (deadline
  = first R32 kickoff). Scoring: points per correct advancement, escalating by
  round (e.g. R16 correct = 1, QF = 2, SF = 4, Final = 8, Champion = 16), plus
  optional bonus for exact final/score.
- Table `bracket_entry`: `id`, `league_id` (nullable for a global bracket),
  `manager_id`, `locked_at`, `created_at`.
- Table `bracket_pick`: `(bracket_entry_id, slot)` → predicted `national_team_id`
  where `slot` encodes the bracket position/round.
- Scoring is **derived**: `src/data/sidegames/bracket-score.ts` compares picks
  to actual results (`fixture` outcomes + `national_team.eliminated_at_stage`)
  and totals points. No stored score.
- Show a bracket UI (reuse a standard bracket layout); pre-fill suggestions from
  `stage_odds` (the favorites) as a convenience.
- Per-league leaderboard + an optional global bracket leaderboard.

### 5.2 Survivor pool
- Each round (stage) the manager picks one nation expected to win/advance; a
  nation can be used at most once across the tournament; a wrong pick costs a
  life (commissioner sets lives, default 1). Last manager standing wins; ties
  share.
- Table `survivor_entry`: `id`, `league_id`, `manager_id`, `lives_remaining`,
  `eliminated_at_stage` (nullable), `created_at`.
- Table `survivor_pick`: `(survivor_entry_id, stage)` → `national_team_id`, with
  a per-entry uniqueness on the nation (enforce in service + a partial index).
- Resolution is **derived** per stage: `src/data/sidegames/survivor.ts` reads
  results and decrements lives / sets elimination. Run it in the post-stage
  cron step (idempotent).
- Deadlines: a pick locks at the first kickoff of that stage; missing a pick
  counts as a loss of a life (or auto-pick highest `stage_odds` favorite — make
  it a flag).

### 5.3 Shared concerns
- Both are gated by `bracket` / `survivor` feature flags.
- Both emit `activity_event`s and notifications (lock reminders, eliminations).
- Both expose their own leaderboard pages and tie into the Stats Hub nav.

## Tasks
- [ ] Migration `00NN_sidegames.sql`: `bracket_entry`, `bracket_pick`,
      `survivor_entry`, `survivor_pick` (+ uniqueness/indexes).
- [ ] `src/data/sidegames/bracket-score.ts` (+ spec): round-weighted scoring vs
      actual results.
- [ ] `src/data/sidegames/survivor.ts` (+ spec): pick validation (no reuse),
      per-stage resolution, lives/elimination, idempotency.
- [ ] Routes: create/lock bracket, submit/list bracket picks, leaderboard;
      submit survivor pick, survivor status, leaderboard.
- [ ] Deadline enforcement tied to first kickoff per stage; optional auto-pick
      from `stage_odds`.
- [ ] Hook survivor resolution + bracket scoring into the post-stage cron step.
- [ ] Bracket UI + survivor UI + leaderboards; flags `bracket`, `survivor`.

## Acceptance criteria
- [ ] Bracket score equals the round-weighted sum of correct advancements on
      seeded results (spec-verified, including a champion-correct case).
- [ ] Survivor rejects reusing a nation and a pick after lock; resolution
      decrements lives correctly and is idempotent under cron rerun.
- [ ] Picks lock at the correct kickoff; missed picks handled per the configured
      rule.
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Real-money entry/prizes.
- Confidence-pool variants (could extend bracket later).

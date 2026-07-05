# Phase 9 — Multi-Competition Foundation (design note)

Status: **enabling refactor DONE; Priority 1 (SET_LINEUP + captain/VC) DONE**
(branch `phase-09-multi-competition`).

## What shipped

- `drizzle/0012_multi_competition.sql` (idempotent, append-only): guarded
  `competition_kind` + `league_format` enums; `competition` and
  `scoring_period` tables; `league.competition_id` (nullable FK),
  `league.format` (default `BEST_BALL`), `fixture.scoring_period_id`
  (nullable FK). The backfill lives IN the migration: seeds
  "FIFA World Cup" / "2026" with nine `scoring_period` rows mirroring the
  stage enum (ordinal 1-9, `stage_code` set), points existing leagues and
  fixtures at them. Every statement no-ops on re-run (proven by a test that
  replays the whole file against a migrated DB).
- Schema: new domain file `src/data/db/schema/competition.ts`, enums in
  `enums.ts`, barrel re-export. All additive; nothing on the scoring spine
  (`stat_line` / `score_entry` / `roster_slot`) changed.
- New pure service `src/data/competition/periods.ts`:
  - `PeriodRef { id, ordinal, label, stageCode }`
  - `getScoringPeriods(db, competitionId)` — the league's competition's
    periods by ordinal; falls back to `stageFallbackPeriods()` (the stage
    enum as PeriodRefs) when `competition_id` is null or unseeded.
  - `assignFixturesToPeriods(periods, fixtures)` — fixture -> ordinal,
    preferring `scoring_period_id`, falling back to `stage_code == stage`.
- `computeStandings` now loops `getScoringPeriods(...)` instead of the
  stage enum and sums points per assigned period. For a WC league both the
  fallback and the seeded-periods path produce the same nine periods in the
  same order -> byte-identical output (golden test asserts JSON equality).

## Decisions (for the next Claude)

1. **`format` vs `head_to_head` flag boundary** (as recommended by the
   hand-off): `league.format` governs how a PERIOD SCORE is produced
   (`BEST_BALL` = retroactive optimal XI; `SET_LINEUP` = submitted XI).
   The `head_to_head` feature flag governs how period scores ROLL UP into
   standings (points table vs W-L-T matchups). `HEAD_TO_HEAD` exists as an
   enum value for forward-compat but the flag is the intended mechanism;
   don't create leagues with `format = 'HEAD_TO_HEAD'`.
2. **Fallback semantics**: `competition_id` NULL -> stage-enum periods.
   This protects pre-backfill rows AND means `createLeague` (which does not
   yet set `competition_id`) keeps producing correct WC leagues. When PL/CL
   arrive, league creation must take a competition; do it then.
3. **`stage` stays, deliberately**: `fixture.stage` (NOT NULL), the
   `standings_snapshot.stage` column, WC tie-breaker #2 ("points in the
   Final", still `stage === 'FINAL'`), `snapshot.ts` and
   `src/web/standings-view.ts` all remain stage-typed. `PeriodResult.stage`
   is populated with `period.stageCode ?? label` so its JSON shape is
   unchanged (byte-identity requirement). Generalizing those consumers +
   making `fixture.stage` nullable is the FIRST job of the set-lineup /
   PL-ingest work, not this phase.
4. **Cross-competition fixtures**: pre-Phase-9 code summed ALL fixtures by
   stage (single-competition assumption). Matching still falls back to
   stage for fixtures with NULL `scoring_period_id`, preserving behavior.
   Once PL fixtures exist they MUST carry `scoring_period_id` so they never
   stage-collide with WC periods.
5. **Backfill in-migration**, not a separate script: it must run exactly
   once per environment in order, which is what the migration runner
   already guarantees, and it is idempotent anyway.

## Verification evidence (2026-07-03, sandbox)

- `tsc --noEmit`: clean.
- Unit: 237/237 (incl. new `test/unit/scoring-periods.test.ts`).
- Integration: all 16 files pass against embedded Postgres 18
  (incl. new `test/integration/multi-competition-golden.test.ts`:
  byte-identical standings before/after backfill; 0012 replayed
  end-to-end against a migrated DB with no error and no duplicates).
- Component: 66/66.

## Priority 1 as-built (SET_LINEUP + captain/VC)

- `drizzle/0013_set_lineup.sql`: `lineup` table, PK (fantasy_team_id,
  scoring_period_id), `player_ids` jsonb (exactly 11), captain + optional
  vice FKs. Additive; only `format = 'SET_LINEUP'` leagues touch it.
- `src/data/lineup/service.ts`: `submitLineup` (format guard, period must
  belong to the league's competition, LOCK at the period's first kickoff -
  fixtures matched the same way scoring matches them, `now` injectable for
  tests), `validateLineupSelection` (11 distinct rostered players forming
  one of the four legal formations - reuses `LEGAL_FORMATIONS`; captain and
  vice in the XI), `effectiveLineupForOrdinal` (ROLL-FORWARD: a period with
  no row uses the most recent earlier submission, FPL-style),
  `getLineups`/`getLineupsForTeams`. Errors: `LineupError` (mapped to 400
  in `src/web/api.ts` like the other domain errors).
- `src/data/standings/set-lineup.ts` (pure): `scoreSetLineupPeriod` -
  submitted XI scored per period; CAPTAIN DOUBLES if they FEATURED
  (minutes > 0 in a period fixture, from stat_line); otherwise the VICE is
  promoted and doubled (if they featured); neither featured -> no double.
  Doubling shows in the captain's XI slot, so period total == sum of slots.
  No lineup (and nothing to roll forward) -> 0 points, "-" formation.
- `computeStandings` branches per league: `format === 'SET_LINEUP'` loads
  lineups/appearance ONLY then; the best-ball block is untouched
  (regression-proven: a best-ball league with lineup rows force-inserted
  computes byte-identical standings).
- `createLeague` gained optional `format` + `competitionId`; SET_LINEUP
  REQUIRES a competition with seeded periods (`FORMAT_REQUIRES_COMPETITION`
  / `COMPETITION_HAS_NO_PERIODS`). POST /api/leagues accepts both fields.
- New route `app/api/leagues/[leagueId]/lineup`: GET (team's lineups + all
  periods with `locksAtUtc`), PUT (own-team-only submission).
- Tests: `test/unit/lineup.test.ts` (validation / roll-forward / captain
  scoring, 17 cases), `test/integration/set-lineup.test.ts` (7 cases:
  create-guard, submit/replace/lock/illegal, format guard, captain double
  vs best-ball, vice promotion, roll-forward, best-ball unaffected).
- Verified 2026-07-03: tsc clean; 254 unit; touched integration suites
  (set-lineup, golden, standings, leagues, league-scoring, scoring, awards,
  team-of-the-stage) all green on embedded PG 18.

## Deliberately NOT in Priority 1 (next steps)

- No lineup-setting UI yet - the API is ready; build the page next session.
- League creation UI does not expose format/competition yet.
- Period-lock reminder notifications (extend the Phase 0 hub).
- Bench order / auto-subs (FPL-style) - out of scope; roll-forward + vice
  promotion is the only automatic behavior.

## Next (per the Phase 9 hand-off, section 4)

Priority 2: head-to-head (`matchup` table, `head_to_head` flag,
`phase-04-head-to-head.md`) - period totals come from whatever base format
the league uses, which now includes SET_LINEUP.

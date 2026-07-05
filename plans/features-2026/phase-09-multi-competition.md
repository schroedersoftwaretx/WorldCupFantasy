# Phase 9 — Multi-Competition Foundation (design note)

Status: **enabling refactor DONE; Priority 1 (SET_LINEUP + captain/VC) DONE;
Priority 2 (head-to-head) DONE; Priority 3 (chips) DONE**
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

## Priority 2 as-built (head-to-head)

Reconciled `phase-04-head-to-head.md` (written pre-Phase-9, stage-based)
with the multi-competition model: the schedule keys on `scoring_period_id`,
not the stage enum, and the table is named `matchup` per the Phase 9
hand-off.

- `drizzle/0014_head_to_head.sql`: `matchup` (league, scoring_period, home/
  away fantasy team; unique per team per period). ONLY the schedule is
  stored - results are always derived, so stat corrections self-heal every
  record (same philosophy as standings).
- `src/data/h2h/schedule.ts`: `generateRoundRobin` - deterministic circle
  method; odd counts get one bye per round; more periods than rounds wraps
  balanced; fewer truncates to a balanced partial. `generateSchedule`
  requires the `head_to_head` flag ON and `league.competition_id` set
  (H2H_REQUIRES_COMPETITION); regeneration allowed until any SCHEDULED
  period FINALIZES (all its fixtures FINISHED) -> H2H_SCHEDULE_LOCKED.
  Enabling H2H mid-tournament works: earlier periods score retroactively.
- `src/data/h2h/results.ts`: pure builders + `computeH2h`. One
  `computeStandings` call feeds everything, so period totals respect the
  league's base format (BEST_BALL or SET_LINEUP). Win 3 / draw 1 / loss 0;
  table ranked by H2H points then season total, shared ranks; pairwise
  `rivalries` records; unfinalized matchups returned with live points and
  `outcome: null`.
- Routes: `GET /api/leagues/[leagueId]/h2h` (member-gated, flag-gated,
  echoes flag config e.g. `{ primaryStandings }`),
  `POST .../h2h/schedule` (owner-only). `H2hError` -> 400.
- Tests: `test/unit/h2h.test.ts` (10: round-robin coverage/byes/balance/
  determinism, results, table, rivalries),
  `test/integration/h2h.test.ts` (4: flag gate + 9-period schedule,
  derived results/table/rivalries, regen lock, competition requirement).
- NOT built (deliberate): matchups UI, `bracket`/playoffs (own flag,
  later), `config.primaryStandings` rendering choice (config is stored and
  echoed; view work), activity events (Phase 3 social is deferred).

## Priority 3 as-built (chips + best-ball period captain)

Reconciled `phase-06-chips-strategy.md` (stage-based, best-ball-only) with
Phase 9: tables key on `scoring_period_id` and the overlay works for BOTH
formats. Wildcard/free-hit are excluded (they need transfers - Priority 5);
the chip set is TRIPLE_CAPTAIN, BENCH_BOOST, STAGE_BOOST.

- `drizzle/0015_chips.sql`: `period_captain` (PK team+period -> player;
  the phase-06 "stage_captain", renamed) and `chip_play` (unique
  (league, team, chip) = one use each; unique (league, team, period) = no
  stacking). Both are INTENT rows; score_entry is never written.
- `src/data/chips/service.ts`: `setPeriodCaptain` (BEST_BALL only -
  SET_LINEUP captains live on the lineup, error CAPTAIN_VIA_LINEUP;
  rostered check), `playChip` (one-use, no-stack, TRIPLE_CAPTAIN requires
  a captain: a period_captain row for best-ball, any effective lineup for
  set-lineup), `getChipState`. All selections lock at the period's first
  kickoff (same rule + fixture matching as lineups); everything behind the
  `chips` flag (CHIPS_FLAG_DISABLED). `ChipsError` -> 400.
- Overlay in `computeStandings`, applied ONLY when the flag is on (flag
  off = byte-identical standings, spec-verified):
  - Best-ball captain: the captain's period points are scaled (x2, x3
    under TRIPLE_CAPTAIN) BEFORE the optimizer runs, so the optimizer can
    prefer fielding the captain.
  - Set-lineup TRIPLE_CAPTAIN: the lineup captain's doubling becomes x3
    (a promoted vice inherits the x3).
  - BENCH_BOOST: the whole 23-man roster scores (formation label "ALL",
    23 XI slots, slot sum == total). Captain multipliers still apply.
  - STAGE_BOOST: the period total is doubled AFTER captain/bench effects.
    NOTE: XI slots stay raw for this chip, so slot sum != total - the
    only such case; documented choice.
  - H2H inherits all of this automatically (it reads computeStandings).
- Routes: `GET/POST /api/leagues/[leagueId]/chips` (state / play, own team
  only), `PUT .../chips/captain`.
- Tests: `test/unit/chips-overlay.test.ts` (4), `test/integration/
  chips.test.ts` (6: flag gate, captain x2/x3 + one-use + no-stack, bench
  boost 23 + stage boost double, locks + roster validation, flag-off
  byte-identity, set-lineup TC via lineup captain).
- NOT built (deliberate): chips UI panel, projected-impact display, lock
  reminders + post-lock reveal (needs Phase 3 social / notification work),
  per-league chip config (which chips enabled, multiplier values) - flag
  `config` is stored but not yet consulted.

## UI as-built (closes the Priority 1-3 deferred UI)

- `app/leagues/[leagueId]/lineup/` - SET_LINEUP XI picker (period select
  with lock times, formation legality gating, captain/vice, roll-forward
  notice; PUT to the lineup API). Best-ball leagues get a notice.
- `app/leagues/[leagueId]/matchups/` - H2H table, per-period fixtures
  (Final/Live tags, trophy on the winner), rivalries; owner
  generate/regenerate button. Flag-gated.
- `app/leagues/[leagueId]/chips/` - captain nomination (best-ball only;
  SET_LINEUP points to the Lineup page) + chip plays with remaining/played
  state. Flag-gated.
- `league-tabs.tsx`: head_to_head is now a real "Matchups" tab (removed
  from FUTURE_TABS); "Lineup" tab appears for SET_LINEUP leagues; "Chips"
  tab when the flag is on.
- Component tests: `lineup-editor.test.tsx` (4), `chips-panel.test.tsx`
  (4), in the existing jsdom style.

## Next (per the Phase 9 hand-off, section 4)

Priority 4 (engagement/social: chat, recaps, awards extensions, side
games) or Priority 5 (transactions: waivers/FAAB or FPL-style transfers,
`league_format`-gated). Remaining UI polish: create-league format picker,
projected chip impact, lock reminders via the notification hub.

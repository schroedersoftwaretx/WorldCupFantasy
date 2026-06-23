# Migration plan: football-data → SofaScore (ID-remap, rosters preserved)

## Why

`STATS_PROVIDER=football-data`. football-data.org's free tier returns match
scores and events but **no lineups**, and `mapFdFixtureStats` derives per-player
minutes (and therefore every stat) from the lineup. With no lineup, every
finished match yields zero stat lines (`ingest:fixture-stats` → `inserted=0`),
so `score:recompute` has nothing to score. This affects the whole tournament,
not just one player. SofaScore is the project's only free, WC-complete
per-player source (see `src/data/provider/select.ts`).

## The core idea: swap source IDs, keep internal IDs

Each provider uses its own ID space. The naïve switch (`ingest:squads` under
SofaScore) keys players by `sourcePlayerId`, so it would **insert ~1,100 new
player rows** with new serial `player.id`s, orphaning every drafted roster.

But every roster/stat reference points at the **internal serial id**, never at
`sourcePlayerId`:

- `roster_slot.player_id → player.id`
- `draft_pick.player_id → player.id`
- `stat_line.(player_id, fixture_id) → player.id / fixture.id`
- `score_entry`, `projected_score_entry` → same
- `stat_line.fixture_id`, `match_odds.fixture_id` → `fixture.id`

So the migration keeps `national_team.id`, `player.id`, and `fixture.id`
**stable**, and only rewrites the three provider-specific columns:

- `national_team.source_team_id`
- `player.source_player_id`
- `fixture.source_fixture_id`

Rosters, draft history, leagues — all untouched. After the swap,
`STATS_PROVIDER=sofascore` and the existing ingest/score pipeline just works.

### Favorable starting condition

`stat_line` and `score_entry` are effectively **empty** (football-data never
produced a usable line). So there is no historical stat data to migrate or
reconcile — a clean slate. If any stat rows do exist, delete them before the
swap (they're in the wrong ID space anyway and will be regenerated).

## Build the crosswalk

SofaScore exposes `fetchSquads()`, `fetchSchedule()`, `fetchFixtureStats()`.
Pull SofaScore's squads and schedule, then match to existing DB rows:

1. **Teams** — match `national_team` by normalized name (48 teams; small enough
   to eyeball any misses). Produce `db_team_id → sofascore_source_team_id`.
2. **Players** — for each existing `player`, restrict candidates to the same
   national team, then match on normalized full name. Produce
   `db_player_id → sofascore_source_player_id`.
3. **Fixtures** — match each `fixture` on `(home_team, away_team, kickoff_utc)`
   using the team crosswalk from step 1. Produce
   `db_fixture_id → sofascore_source_fixture_id`.

### Matching risk (the real work)

Name spellings differ across providers (accents, "Christian Pulisic" vs
"C. Pulisic", initials). Plan:

- Normalize: lowercase, strip accents/diacritics, collapse whitespace, drop
  punctuation.
- Try exact normalized match within team; fall back to last-name + first-initial.
- **Emit an unmatched report** and require manual resolution before any write.
  Do NOT auto-write partial matches. Target: 100% of players on drafted rosters
  matched (others can be backfilled later).

## Execution steps

1. **Branch + backup.** New git branch. `pg_dump` the database (or Neon branch
   snapshot) so the swap is reversible.
2. **Dry-run crosswalk script** (`scripts/remap-to-sofascore.mjs`, read-only):
   builds all three crosswalks, prints counts and a full unmatched list.
   Iterate on the matcher until every drafted-roster player resolves.
3. **Resolve leftovers** via a small manual overrides map in the script
   (`{ db_player_id: sofascore_source_player_id }`).
4. **Apply in one transaction:** update `source_team_id`, `source_player_id`,
   `source_fixture_id`. Guard the unique indexes (`*_source_*_id_uq`) — write to
   temporary sentinel values first if any new ID collides with an old one
   mid-update, or just rely on the tx + distinct ID spaces.
5. **Flip env:** `STATS_PROVIDER=sofascore` (remove/keep `FOOTBALL_DATA_KEY`;
   SofaScore needs no key). Update both `.env` and Vercel.
6. **Verify:** `npm run cli ingest:fixture-stats 537345` → expect `inserted>0`;
   then `npm run cli score:recompute 537345`; then
   `node --env-file=.env diagnose-pulisic.mjs` → Pulisic should now show a
   `stat_line` and a `score_entry`.
7. **Backfill any earlier finished fixtures:** `npm run cli ingest:all`.

## Verification checklist

- Pulisic (and a second spot-checked player) have non-empty `stat_line` +
  `score_entry` after the run.
- `roster_slot` / `draft_pick` row counts unchanged; sample picks still resolve
  to the same player names (internal IDs preserved).
- Every drafted-roster player matched in the crosswalk (zero unmatched among
  rostered players).
- Standings page renders and reflects the newly scored match.
- Re-running `ingest:fixture-stats` for the same fixture is idempotent
  (`skipped`, not duplicate inserts).

## Rollback

Restore the pre-migration dump / Neon branch and revert `STATS_PROVIDER`.
Because internal IDs never changed, rollback only loses the ID-space swap.

## Scope estimate

- `scripts/remap-to-sofascore.mjs` (dry-run + apply modes): ~150–250 lines.
- Matcher tuning + manual overrides: the bulk of the effort, name-dependent.
- No schema/Drizzle migration needed — this is a data update, not a DDL change.
- One env flip in two places.

## Open questions for Aidan

1. Confirm SofaScore is acceptable as the season-long source (it's the only free
   WC-complete feed; football-data paid coverage of WC lineups is unverified).
2. OK to treat existing `stat_line`/`score_entry` as disposable (regenerate from
   SofaScore)?
3. Should I build `scripts/remap-to-sofascore.mjs` now in dry-run mode so we can
   see the unmatched-player report before committing to anything?

# Phase 7 — Awards, Golden Boot & Bonus/Streak Scoring

**Prerequisites:** Phase 1 (stats aggregate, best-haul query).
**Read first:** `PLAN.md` §2-3, `src/data/scoring/ruleset.ts`, `score.ts`,
`recompute.ts`.

## Goal

Give managers things to chase beyond the overall lead: **tournament-long
awards** (Golden Boot, etc.) that run parallel to gameweek scoring, a **best
single-match haul** tracker, and optional **bonus/streak/milestone** scoring
that keeps blowout knockout games exciting.

## Why

Even a manager out of the lead should have a trophy to play for. Season-long
awards and bonus multipliers add multiple parallel competitions over the same
data, increasing the number of "I'm winning something" moments.

## Design / approach

### 7.1 Tournament awards (derived)
- A registry of awards computed from existing data, no new writes:
  - **Golden Boot (fantasy)** — most rostered-player goals; **Playmaker** —
    most assists; **Golden Glove** — most clean sheets/saves by your keepers.
  - **Manager awards**: highest single-stage total, best single-XI, best draft
    value (ties to Phase 2), best differential haul, most consistent (lowest
    variance across stages).
  - **Best single-match haul** — top `score_entry.points` among a team's
    rostered players (query built in Phase 1; surface here per team and
    league-wide).
- `src/data/awards/registry.ts`: each award is `{ id, label, compute(ctx) }`
  returning a ranked list. Pure, spec-tested, recomputable. A league "Trophy
  Room" page renders current leaders; finalize at tournament end.

### 7.2 Bonus / streak / milestone scoring (opt-in ruleset extension)
This is the only part that touches scoring — do it as an **additive, versioned
ruleset extension** so existing leagues are unaffected.

- Extend `ScoringRuleset` (in `ruleset.ts`) with an optional `bonuses` block,
  e.g. milestone multipliers (hat-trick bonus, brace bonus), knockout-stage
  multipliers (points in SF/Final worth more), and streak bonuses (a player
  scoring in N consecutive matches). All default to **off/zero** so the existing
  version hash and totals are unchanged for current leagues.
- Because `ruleset.version` is a content hash, adding bonuses yields a **new**
  version automatically; `recompute.ts` rebuilds only affected leagues. Verify
  the default ruleset's hash does **not** change (additive optional fields must
  preserve the existing serialization for the default).
- Compute bonuses inside `score.ts` from `stat_line` (and `fixture.stage` for
  stage multipliers) so they flow through `score_entry` like everything else —
  no overlay needed here (unlike chips, these are real scoring rules a league
  adopts).
- Streaks need cross-fixture context: add a small pre-pass in `recompute.ts`
  that, per player, walks their fixtures in kickoff order to detect streaks,
  then feeds a per-entry flag into scoring. Keep it pure and deterministic.

### 7.3 Surfaces
- "Trophy Room" page per league + a global awards section in the Stats Hub.
- Show live award standings during the tournament (provisional) and lock at the
  end.
- Notify on award lead changes (optional, via Phase 0) — debounce to avoid spam.

## Tasks
- [ ] `src/data/awards/registry.ts` (+ spec): all derived awards, ranked.
- [ ] Routes: `GET` league trophy room, `GET` global awards.
- [ ] Trophy Room UI + Stats Hub awards section; best-haul surfaced per team.
- [ ] Extend `ScoringRuleset` with optional `bonuses` (default off); prove the
      default version hash is unchanged (spec).
- [ ] Implement bonus computation in `score.ts`; add the streak pre-pass in
      `recompute.ts` (+ specs covering hat-trick, stage multiplier, streak).
- [ ] Commissioner UI to enable bonuses for a league (creates a new ruleset
      version; triggers recompute for that league only).

## Acceptance criteria
- [ ] Every award's ranking matches hand-computed expectations on seeded data.
- [ ] With `bonuses` unset, the default ruleset version hash and all existing
      `score_entry` totals are byte-for-byte unchanged (spec-verified).
- [ ] Enabling a bonus produces a new ruleset version and recomputes only that
      league; hat-trick/stage/streak bonuses apply correctly and deterministically.
- [ ] `npm run typecheck` and `npm test` pass.

## Out of scope
- Per-manager custom scoring (league-level only).
- Retroactively changing a league's ruleset mid-stage without explicit
  commissioner action.

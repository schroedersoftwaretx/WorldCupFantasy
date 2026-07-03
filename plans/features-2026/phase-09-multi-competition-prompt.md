# Phase 9 — Multi-Competition & Competitor-Parity Formats (hand-off prompt)

> **You are Claude Fable, picking up an existing, live fantasy-soccer codebase.**
> Read this whole document once before writing any code. It is written to be
> self-contained: it tells you the ground truth of the current system, the
> mission, the hard constraints, the exact enabling refactor to do first, the
> feature backlog after that, and how to verify your work. Do not skip the
> constraints section — there are paying leagues running on this code right now.

---

## 0. Mission in one paragraph

Grow this app from a **World-Cup-only best-ball draft league** into a
**multi-competition fantasy platform** that can run leagues for the **Premier
League** and **Champions League** next season, and that offers the format and
engagement features people expect from **ESPN, Yahoo, and Sleeper** (head-to-head,
set-your-lineup, captains, waivers/trades, chips, chat, side games). This must
happen **without changing the behavior of any currently running best-ball
league.** Existing leagues must compute byte-identical standings before and
after your work.

---

## 1. Ground truth — the current architecture (verified, do not assume otherwise)

- **Stack:** Next.js 15 (App Router, React 19), TypeScript, Postgres via Drizzle
  ORM, Firebase auth (server session cookie; the `manager` row is the app user,
  keyed by `firebase_uid`), deployed on Vercel.
- **Data-layer / web split (keep it):** all business logic lives in `src/data/**`
  as pure, framework-agnostic services grouped by concern — `scoring/`,
  `standings/`, `draft/`, `league/`, `roster/`, `projection/`, `ingest/`,
  `odds/`, `provider/`, `stats/`, `notify/`, `awards/`. Route handlers in
  `app/**` and React components are thin adapters. **Never put scoring or
  aggregation logic in a route handler or component.**
- **Schema:** split by domain under `src/data/db/schema/` and re-exported from
  the barrel `src/data/db/schema.ts`. Domain files:
  `enums.ts`, `football.ts`, `leagues.ts`, `draft.ts`, `odds.ts`,
  `notifications.ts`.

### 1.1 The scoring spine (this is sacred — understand it before touching anything)

- **`stat_line`** — IMMUTABLE per-player, per-fixture raw stats. Only the ingest
  path writes it. `team_conceded_in_regulation_and_et` excludes shootouts.
- **`score_entry`** — DERIVED and disposable; fully recomputable from `stat_line`
  by `src/data/scoring/recompute.ts`. **Keyed in part by `ruleset_version`** so
  multiple rulesets coexist for what-if analysis and cache invalidation.
- **`ScoringRuleset`** (`src/data/scoring/ruleset.ts`) — a pure-data object whose
  `version` is a **content hash** of its own values (e.g. `wcf-v1-5c4f7b33`).
  Same values → same id; any change → new id. Stored per-league in
  `league.scoring_ruleset` (jsonb).
- **`standings`** and the best-ball starting XI are **pure reads** over
  `score_entry` + rosters (`src/data/standings/`). `standings_snapshot` persists
  per-stage cumulative rank for movement arrows. Standings are never stored as
  canonical truth — they are recomputed on demand, which is the "live updates"
  story with no websocket machinery.

### 1.2 The current format (what you must NOT break)

- A **best-ball draft** league: a 23-man roster per fantasy team, drafted via a
  **snake draft** (`draft_room`, `draft_order`, `draft_pick`, `draft_queue`,
  with constraint-aware autopick). **No trading, no waivers, no in-season roster
  changes, no set lineup, no captain.**
- **Best-ball optimizer** (`src/data/standings/lineup.ts`): for each scoring
  period the system retroactively picks the highest-scoring LEGAL starting XI
  (1 GK + 10 outfielders; DEF 4-5, MID 2-4, FWD 2-3 → exactly 4 formations).
  There is **no lineup deadline** — the optimum is chosen after the fact.
- **Roster rules** (`src/data/roster/validator.ts`): 23 players, GK 2-4,
  DEF 6-8, MID 5-8, FWD 4-8. Maximums double as per-manager draft caps.
- **`roster_slot`** enforces "a real player is drafted at most once per league"
  via a unique `(league_id, player_id)`.

### 1.3 The blocker for PL/CL (the reason this phase exists)

Scoring periods are **hardcoded to the World Cup knockout enum**:

```ts
// src/data/db/schema/enums.ts
export const stageEnum = pgEnum("stage", [
  "GROUP_1","GROUP_2","GROUP_3","R32","R16","QF","SF","THIRD_PLACE","FINAL",
]);
// src/data/standings/standings.ts
export const SCORING_PERIODS: readonly Stage[] = stageEnum.enumValues; // 9 fixed
```

`fixture.stage`, `standings_snapshot`, and the standings loop are all built on
this 9-value enum. **The Premier League is 38 gameweeks; the Champions League is
a league phase + knockout — neither fits an enum.** Generalizing the scoring
period is the enabling refactor and must come first.

### 1.4 Already-present machinery you should reuse (don't rebuild)

- **Per-league feature flags** — `src/data/league/feature-flags.ts` with a
  `league_feature_flag` table and `getFlags` / `isFlagEnabled` / `setFlag`.
  Flags already declared (all default OFF): `stats_hub`, `chat`, `head_to_head`,
  `bracket`, `survivor`, `chips`, `awards`. **A best-ball league is unchanged by
  default because every flag is off.** Gate all new format features here.
- **App-wide notification hub** (Phase 0) + **notification preferences** +
  durable queue. Reuse for any new notifications; do not invent a second system.
- **SofaScore ingest** (`src/data/ingest/`, `scripts/ingest-sofascore.ts`).
  ⚠️ Known operational constraint: **cron cannot reach SofaScore** (needs an
  `x-requested-with` header + Playwright); today refresh is manual via the
  script. Factor this into any PL/CL ingest plan — do not assume a serverless
  cron can pull live club data.

### 1.5 Migration rules (violating these breaks the live DB)

- Migrations are **append-only, numbered, and HAND-WRITTEN**. The latest is
  `drizzle/0011_playmaker_stats.sql`. **Your first new migration is `0012`.**
- **Do NOT run `drizzle-kit generate` / `npm run migrate:generate`.** The repo's
  drizzle meta snapshots stop at an early migration, so `generate` diffs against
  that and re-emits already-applied migrations, including non-idempotent
  `ADD COLUMN`s that fail on the live DB.
- Hand-write **idempotent** SQL in the existing style: `CREATE TABLE IF NOT
  EXISTS`, `ADD COLUMN IF NOT EXISTS`, and guarded enum creation
  (`DO $$ BEGIN CREATE TYPE ... EXCEPTION WHEN duplicate_object THEN null; END
  $$;`). Add the matching `_journal.json` entry. Never hand-edit an existing
  migration.

---

## 2. Hard constraints (the whole point of this phase)

1. **Do not change any running best-ball league's results.** A WC best-ball
   league must produce byte-identical standings, XIs, and formations after your
   changes. This is the #1 acceptance test.
2. **Never mutate a live league's `scoring_ruleset` or its `ruleset_version`.**
   New rules ship as new ruleset versions on new leagues only.
3. **Never change the semantics of `stat_line`, `score_entry`, or `roster_slot`.**
   New formats are *additive tables* and *new read paths*, never rewrites of the
   spine.
4. **Every new format/feature is opt-in via a `league_feature_flag`** (or the
   new `league_format` discriminator) and defaults to the current behavior.
5. **Migrations idempotent and append-only** (see 1.5).
6. **Keep the data-layer/web split** (see 1.1). Pure services in `src/data/**`;
   thin adapters in `app/**`.

---

## 3. The enabling refactor — DO THIS FIRST (no user-visible feature yet)

Goal: make "what competition is this, and what are its scoring periods" data,
not a hardcoded enum — while leaving existing WC leagues computing identically.

### 3.1 New concepts

- **`competition`** table: one row per real-world competition-season, e.g.
  "FIFA World Cup 2026", "Premier League 2026/27", "UEFA Champions League
  2026/27". Columns at minimum: `id`, `name`, `kind` (enum:
  `WORLD_CUP` | `LEAGUE` | `CONTINENTAL_CUP`), `season_label`, timestamps.
- **`scoring_period`** table: replaces the `stage` enum's role. One row per
  period of a competition, e.g. WC stages, PL gameweeks 1-38, CL matchdays +
  knockout rounds. Columns: `id`, `competition_id`, `ordinal` (1-based order),
  `label` (e.g. "GW1", "Group Stage", "Final"), optional `stage_code` for cups,
  `starts_at` / `ends_at`, timestamps. **This is the generic replacement for
  `SCORING_PERIODS`.**
- **`league.competition_id`** — FK from league → competition (nullable during
  migration, then backfilled).
- **`league.format`** — new enum discriminator, **default `BEST_BALL`**. Values
  to define now: `BEST_BALL`, `SET_LINEUP`, `HEAD_TO_HEAD` (H2H can also be a
  flag layered on a base format — decide and document; recommended: `format`
  governs how a *period score* is produced, and `head_to_head` flag governs how
  periods roll up into standings).
- **`fixture.scoring_period_id`** — FK from fixture → scoring_period, alongside
  (not replacing, during transition) the existing `stage` column.

### 3.2 Backfill / compatibility plan (this is what protects live leagues)

1. Seed one `competition` row of kind `WORLD_CUP` for the current tournament.
2. Seed nine `scoring_period` rows for it, one per existing `stage` enum value,
   preserving order in `ordinal`.
3. Backfill `league.competition_id` for existing leagues to that competition and
   `league.format = 'BEST_BALL'`.
4. Backfill `fixture.scoring_period_id` from each fixture's `stage`.
5. Refactor `SCORING_PERIODS` and the standings loop to read periods from
   `scoring_period` (ordered by `ordinal`) **for the league's competition**,
   instead of `stageEnum.enumValues`. For a WC league this returns the same nine
   periods in the same order → identical output.
6. Keep the `stage` enum and column in place for now (WC-specific tie-breakers
   like "points in the Final" still reference it). Do not delete it this phase.

### 3.3 Acceptance for the refactor

- A golden test: snapshot a real WC best-ball league's full standings +
  per-period XIs **before** the refactor, then assert **exact equality** after.
- `npm run typecheck` and `npm test` green.
- No change to any migration ≤ 0011; new work is `0012_multi_competition.sql`.

---

## 4. Feature backlog — competitor parity (after the refactor, in this order)

Each item: additive tables only, flag-gated, best-ball path untouched. The
`features-2026/` folder already has design docs for several of these
(`phase-03-social.md`, `phase-04-head-to-head.md`, `phase-05-side-games.md`,
`phase-06-chips-strategy.md`, `phase-07-awards-bonus-scoring.md`). Read the
relevant one before building; this prompt updates their ordering and the
multi-competition context.

**Priority 1 — cheap, high impact**
- **Captain / vice-captain** (double points for the captain; VC promoted if
  captain doesn't feature). Requires a per-period lineup intent, so it depends on
  the set-lineup work below. Model as part of `lineup`.
- **Set-your-lineup format** (`format = SET_LINEUP`): a new `lineup` table
  (`fantasy_team_id`, `scoring_period_id`, chosen XI + captain/VC), with a
  **lock at the period's first kickoff**. The scoring read for a SET_LINEUP
  league uses the *submitted* XI instead of the best-ball optimizer. Best-ball
  leagues never touch this table.

**Priority 2 — the biggest "matches competitors" win**
- **Head-to-head** (`head_to_head` flag, `phase-04-head-to-head.md`): a
  `matchup` table pairing two fantasy teams per scoring period; standings become
  W-L-T records; add end-of-season **playoffs/bracket** (`bracket` flag).
  Period point totals come from whatever base format the league uses.

**Priority 3 — strategy depth**
- **Chips** (`chips` flag, `phase-06-chips-strategy.md`): wildcard, bench boost,
  triple captain, free hit. `chip_usage` table (`fantasy_team_id`,
  `scoring_period_id`, `chip_type`, one-shot enforcement). Only meaningful for
  set-lineup / transfer formats.

**Priority 4 — engagement / social**
- **League chat / message board / reactions** (`chat` flag,
  `phase-03-social.md`).
- **Power rankings, weekly recaps, matchup previews, awards** (`awards` flag,
  `phase-07-awards-bonus-scoring.md` — partially built already; extend).
- **Side games**: survivor, pick'em, confidence pools (`survivor` flag,
  `phase-05-side-games.md`).

**Priority 5 — largest surface area, do last, keep isolated**
- **In-season transactions**: choose the model per format —
  - waivers + FAAB budget + free-agent add/drop (ESPN/Yahoo style), and/or
  - FPL-style limited free transfers per period with point-hit penalties.
  New tables: `transaction`, `waiver_claim`, `trade` (with propose/accept/veto).
  **This is the feature furthest from best-ball philosophy — it must live behind
  its own `league_format` so best-ball and set-lineup leagues never render it.**
- **Auction draft** and **keeper/dynasty** (carry players across seasons via
  the competition/season model) are natural follow-ons once transactions exist.

**Cross-cutting data/UX**
- Player news / injury / availability feed and surfaced projections (build on
  `src/data/projection/`).
- Deeper mobile + push (Phase 8 handled prefs/polish; extend the notification
  hub for period-lock reminders, waiver results, trade offers, matchup results).

---

## 5. PL/CL ingest (needed for real next-season leagues)

- Extend `src/data/ingest/` + `scripts/ingest-sofascore.ts` to pull club-team
  squads, fixtures, and per-player stat lines for the Premier League and
  Champions League, mapping fixtures to `scoring_period` rows (GW / matchday).
- Reuse the existing `stat_line` fields; club competitions won't have shootout
  edge cases the same way, but keep the immutable-source-of-truth contract.
- ⚠️ **Cron cannot reach SofaScore** (see 1.4). Design the refresh path
  accordingly — e.g. a manually/externally triggered job, a self-hosted worker
  with Playwright, or an alternative provider. Document the chosen approach.
- Seed the `competition` + `scoring_period` rows for PL (38 GW) and CL before a
  league can be created against them.

---

## 6. Season isolation (how "next season" stays clean)

A new season is simply a **new `competition` + new `scoring_period` rows + new
leagues** pointing at it. Old leagues keep referencing the old competition;
nothing mutable is shared. No data migration of last season is required to start
a new one.

---

## 7. How to verify your work (required before calling anything done)

- `npm run typecheck` and `npm test` both green.
- The **golden best-ball equality test** from §3.3 passes.
- For new routes, add `tsx` route-level tests against an embedded Postgres, in
  the existing test style under `test/`.
- Each new format has a unit test proving a best-ball league is unaffected when
  its flag/format is default.
- Provide a short migration dry-run note showing the `0012+` SQL is idempotent
  (safe to run twice).

## 8. Working-environment cautions (from prior sessions)

- **Commit early and often.** A `reset --hard` + PR workflow here has discarded
  uncommitted edits before — don't leave work only in the working tree.
- Large-file writes via some tools can truncate; prefer verified writes and
  confirm file contents after writing big files.
- Do not run `drizzle-kit generate` (see 1.5).

---

## 9. Deliverable for this phase

1. Migration `0012_multi_competition.sql` (idempotent) + `_journal.json` entry.
2. New schema files/tables: `competition`, `scoring_period`, plus
   `league.competition_id`, `league.format`, `fixture.scoring_period_id`.
3. Refactored `SCORING_PERIODS` / standings loop reading from `scoring_period`.
4. Backfill script/SQL for existing WC leagues (§3.2).
5. Golden equality test proving live best-ball leagues are unchanged.
6. A short `phase-09-multi-competition.md` design note recording decisions
   (especially the `format` vs `head_to_head`-flag boundary) for the next Claude.

Then, and only then, pick up Priority 1 from §4.

**Start by reading `plans/features-2026/PLAN.md`, then `src/data/db/schema/*.ts`,
`src/data/scoring/ruleset.ts`, `src/data/standings/*.ts`, and
`src/data/league/feature-flags.ts` to confirm this document against the current
code before writing anything.**

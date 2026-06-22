# Phase 1 Build Prompt — Data Spine

> Copy everything below the line into a fresh Claude / Claude Code session to build
> Phase 1. It is self-contained: it restates only the context Phase 1 needs.

---

## Context

I am building a fantasy draft web application for the **2026 FIFA World Cup**
(June 11 – July 19, 2026; 48 teams, 12 groups of 4; stages: group matches 1–3, Round of
32, Round of 16, quarter-finals, semi-finals, third-place, final). Managers will draft
permanent 23-player squads and earn cumulative points from real match performances.

**This task is Phase 1 only: the data spine.** Do **not** build scoring logic, leagues,
drafting, lineups, or any UI beyond what is needed to verify ingestion. The goal is a
trustworthy, well-abstracted data foundation that later phases build on.

## Stack

- **Language/runtime:** TypeScript on Node.js (this will integrate with a Next.js app
  later; keep the data layer framework-agnostic so it can be imported by a worker
  process and by Next.js server code).
- **Datastore:** PostgreSQL. Use a migration tool (Prisma or Drizzle — pick one,
  justify briefly, and be consistent).
- **Data provider:** API-Football (api-sports.io), v3 REST API. The World Cup is
  available as `league=1`, `season=2026`. Auth is via an API key in a request header.
  The base URL and key must come from environment variables — never hardcode them.

> Note: the API key and live network access are mine to supply at runtime. Write the
> code and tests so they do **not** require live API calls to pass (see Testing).

## Deliverables

### 1. Project scaffold

- A TypeScript project with the data layer in its own module/package boundary
  (e.g., `src/data/`), separate from anything app- or web-specific.
- `.env.example` documenting required variables (`DATABASE_URL`,
  `API_FOOTBALL_BASE_URL`, `API_FOOTBALL_KEY`, ingest tuning vars).
- `README` section explaining how to run migrations, run the ingestion CLI, and run
  tests.

### 2. Database schema + migrations

Implement exactly these entities (Phase 1 scope only — no league/draft/scoring tables):

- **`national_team`** — id, name, FIFA/source team id, group label (A–L),
  `status` enum (`ACTIVE`, `ELIMINATED`), `eliminated_at_stage` nullable.
- **`player`** — id, full name, `position` enum (`GK`, `DEF`, `MID`, `FWD`),
  `national_team_id` FK, source player id (unique per provider), `status` enum
  (`ROSTERED_AVAILABLE` placeholder ok for now — minimally `ACTIVE` / `UNKNOWN`).
- **`fixture`** — id, source fixture id (unique), `stage` enum
  (`GROUP_1`, `GROUP_2`, `GROUP_3`, `R32`, `R16`, `QF`, `SF`, `THIRD_PLACE`, `FINAL`),
  home/away `national_team_id` FKs, kickoff timestamp (UTC), `status` enum
  (`SCHEDULED`, `LIVE`, `FINISHED`), final score nullable.
- **`stat_line`** — **immutable raw stats**, one row per (player, fixture). Fields:
  player_id FK, fixture_id FK, minutes_played, goals, assists, saves, yellow_cards,
  red_cards, penalties_scored, penalties_missed, penalties_saved, own_goals,
  team_conceded_in_regulation_and_et (int, for later clean-sheet derivation),
  `ingested_at`, `source_revision` (so re-ingested corrections are detectable).
  Enforce a unique constraint on (player_id, fixture_id) and treat writes as
  upsert-by-source-revision; never mutate fields outside of a re-ingest from the
  provider.

Schema must make clear in comments that `stat_line` is the **source of truth** and that
derived points (a later phase) must always be recomputable from it.

### 3. Provider abstraction (critical)

Define an internal interface that the rest of the system will depend on **instead of**
the vendor SDK/HTTP directly:

```ts
interface StatsProvider {
  // All 48 squads → players with position + national team.
  fetchSquads(): Promise<ProviderPlayer[]>;

  // All 104 fixtures with stage, teams, kickoff (UTC), status.
  fetchSchedule(): Promise<ProviderFixture[]>;

  // Per-player raw stats for one finished fixture.
  fetchFixtureStats(sourceFixtureId: string): Promise<ProviderStatLine[]>;
}
```

Provide:

- An **`ApiFootballProvider`** implementing this interface against api-sports.io v3,
  using `league=1&season=2026`, with the API key read from env, basic retry/backoff,
  and rate-limit-aware pacing.
- A **`FixtureMockProvider`** implementing the same interface from local JSON fixture
  files (used by tests and for offline development).

Nothing outside the provider module may import the vendor or construct vendor URLs.

### 4. Ingestion CLI

A command-line entry point with subcommands:

- `ingest:squads` — fetch squads, upsert `national_team` + `player`.
- `ingest:schedule` — fetch schedule, upsert `fixture` (map provider rounds to the
  stage enum; document the mapping).
- `ingest:fixture-stats <sourceFixtureId>` — fetch and upsert `stat_line` rows for one
  finished fixture; idempotent (re-running must not duplicate or corrupt rows).

All ingestion must be idempotent and safe to re-run. Log a concise summary
(counts inserted/updated/skipped).

### 5. Tests

- Unit tests for the provider mapping logic (provider response → internal types) using
  committed JSON fixture files representative of real api-sports.io v3 shapes.
- Integration tests for the three ingestion commands using `FixtureMockProvider`
  against a test Postgres database, asserting idempotency (run twice → identical state).
- A test proving the full chain for a finished match: schedule + squads ingested, then
  `ingest:fixture-stats` produces correct `stat_line` rows linked to the right players
  and fixture.

**Tests must pass with zero live network access.**

## Constraints & non-goals

- **Do not** implement scoring, points, leagues, draft, lineups, auth, or UI.
- **Do not** call the live API from tests or make tests depend on a real key.
- **Do not** let provider-specific shapes leak past the `StatsProvider` boundary.
- Keep `stat_line` immutable in spirit: only the ingestion path writes it, and only as
  upsert-from-source.
- Prefer clarity and correctness over cleverness; this layer is depended on by
  everything later.

## Acceptance criteria

1. Migrations create the four tables with the specified enums, FKs, and the
   `(player_id, fixture_id)` uniqueness on `stat_line`.
2. `StatsProvider` interface exists; both `ApiFootballProvider` and
   `FixtureMockProvider` implement it; no vendor imports exist outside the provider
   module.
3. All three ingestion CLI commands run idempotently against `FixtureMockProvider`.
4. The end-to-end test (squads + schedule + one finished fixture's stats) passes with
   no network access.
5. `.env.example`, README run instructions, and the provider-round → stage-enum mapping
   are documented.

When you begin, first restate your understanding of the scope and the schema in a short
plan, then implement. Ask me before adding any dependency beyond the migration tool and
a test runner.

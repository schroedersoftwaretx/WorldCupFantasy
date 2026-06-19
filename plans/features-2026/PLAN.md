# World Cup Fantasy — Feature Expansion Plan (2026)

A phased roadmap to grow the app from a best-ball draft league into a full
fantasy platform with social, head-to-head, side-games, strategy chips, a
tournament-wide stats hub, and richer notifications.

This is the **master hand-off document**. Each phase has its own self-contained
file (`phase-0X-*.md`) written so a fresh Claude can pick it up, read this
master doc once for context, then implement that phase end-to-end.

---

## 1. How to use these docs (for the implementing Claude)

1. **Read this file first.** It establishes the architecture, conventions, and
   the dependency order. Do not skip it.
2. **Then open exactly one `phase-0X-*.md`** and implement only that phase.
   Each phase file lists its prerequisites at the top — confirm they are merged
   before starting.
3. **Each phase ends with an acceptance checklist.** The phase is "done" only
   when every box is checkable and `npm run typecheck` + `npm test` pass.
4. **Keep the data-layer / web split.** Business logic lives in `src/data/**`
   as pure, framework-agnostic services. `app/**` route handlers and React
   components are thin adapters over those services. Never put scoring or
   aggregation logic in a route handler or a component.
5. **Migrations are append-only, numbered, and HAND-WRITTEN.** The latest
   migration is `drizzle/0009_foundations.sql` (Phase 0). New migrations
   continue from `0010`. **Do NOT run `npm run migrate:generate` /
   `drizzle-kit generate`:** the repo's drizzle meta snapshots stop at `0005`,
   so `generate` diffs against that and re-emits `0006`-`0009` — including
   non-idempotent `ADD COLUMN`s that fail on the live DB. Instead hand-write
   idempotent SQL in the `0006`-`0009` style: `CREATE TABLE IF NOT EXISTS`, and
   guarded enum creation (`DO $$ BEGIN CREATE TYPE ... EXCEPTION WHEN
   duplicate_object THEN null; END $$;`). The runtime migrator only needs the
   `.sql` file plus a `_journal.json` entry. Never hand-edit an existing
   migration.

---

## 2. Existing architecture (ground truth)

- **Framework:** Next.js 15 (App Router, React 19), TypeScript, deployed on
  Vercel.
- **DB:** Postgres via Drizzle ORM. Schema is the single file
  `src/data/db/schema.ts`. Migrations in `drizzle/`.
- **Auth:** Firebase (server session cookie). `manager` row is the app-level
  user, keyed by `firebase_uid`.
- **Data layer (`src/data/**`):** pure services grouped by concern —
  `scoring/`, `standings/`, `draft/`, `league/`, `roster/`, `projection/`,
  `ingest/`, `odds/`, `provider/`, `stats/`. Routes import these.
- **Scoring spine (do not break this):**
  - `stat_line` is the **immutable source of truth**, written only by the
    ingest path.
  - `score_entry` is **derived and disposable**, recomputable from `stat_line`
    via `src/data/scoring/recompute.ts`. Keyed by `ruleset_version` so what-if
    rulesets coexist.
  - `standings` and best-ball XI are **pure reads** over `score_entry` +
    rosters (`src/data/standings/`). `standings_snapshot` persists per-stage
    cumulative rank for movement arrows.
- **Format:** a **best-ball draft** league. A 23-man roster per fantasy team;
  for each of the 9 scoring periods (tournament stages) the optimizer in
  `src/data/standings/lineup.ts` retroactively fields the best legal XI
  (formations 4-3-3 / 4-4-2 / 5-2-3 / 5-3-2). There is **no weekly lineup
  setting, no transfers, and no captain today** — several phases below add
  optional strategic layers on top of this without breaking best-ball as the
  default.
- **Realtime:** the draft uses Server-Sent Events implemented as a server-side
  DB poll + diff (`app/api/leagues/[leagueId]/draft/stream/route.ts`,
  `POLL_MS = 1500`). Reuse this pattern for any new "live" surface; do not add a
  websocket server.
- **Automation:** Vercel Cron drives `/api/cron/ingest-and-score` (schedule
  refresh → stat ingest → score recompute → odds → projections → standings
  snapshot) and `/api/cron/draft-tick`. New periodic work hangs off these or a
  new cron route.
- **Notifications:** `draft_notification` is a durable queue (write row PENDING
  → Resend delivery → SENT/FAILED). Phase 0 generalizes this into an app-wide
  notification hub.
- **Stats source:** SofaScore via Playwright (manual refresh through
  `scripts/ingest-sofascore.ts`; cron cannot reach SofaScore). Treat the stat
  provider as already-solved — new features read from `stat_line` /
  `score_entry`, they do not add providers.

---

## 3. Design principles for every new feature

- **Derived, not stored, wherever possible.** Follow the `score_entry` model:
  if a thing can be recomputed from `stat_line` + rosters + a ruleset, compute
  it in a pure function and cache only when measured to be necessary.
- **League-scoped and feature-flagged.** Each major feature is toggleable per
  league (see Phase 0 feature flags) so a commissioner opts in. Defaults keep a
  plain best-ball league unchanged.
- **Pure core + thin edge.** Put the algorithm in `src/data/<area>/` with unit
  tests (Vitest). Routes validate input, call the service, shape the envelope.
- **Idempotent writes.** Anything a cron or a retry can call twice must be
  safe to call twice (upserts keyed on natural keys), matching the existing
  ingest/score paths.
- **Best-ball stays the default truth.** Chips, captains, and H2H are optional
  overlays that read the same `score_entry`; they never mutate it.

---

## 4. Phase map & dependency order

| Phase | Theme | Depends on | Headline features |
|------|-------|-----------|-------------------|
| 0 | Shared foundations | — | Notification hub, realtime feed helper, per-league feature flags, stats service layer, nav shell |
| 1 | Stats Hub | 0 | Team of the Matchday/Stage, tournament leaderboards, records |
| 2 | Player insights | 1 | Cross-league ownership %, ADP/draft analytics, differentials, value |
| 3 | Social | 0 | League chat + reactions, activity feed, auto recaps & power rankings |
| 4 | Head-to-head | 0 | H2H schedule, matchup pages, rivalries |
| 5 | Side-games | 1 | Knockout bracket predictor, survivor pool |
| 6 | Chips & strategy | 0 | Per-stage captain, best-ball-adapted chips |
| 7 | Awards & bonus scoring | 1 | Golden Boot tracker, tournament awards, best haul, streak/milestone multipliers |
| 8 | Notifications & polish | 0,3,6 | Goal/deadline alerts, draft-room polish, mobile pass |

**Recommended build order:** 0 → 1 → 3 → 2 → 4 → 7 → 6 → 5 → 8.
Rationale: ship the foundation, then the highest-retention items early
(Stats Hub, Social), layer player insights and H2H, then the scoring-heavy
overlays (Awards/Chips), the side-games, and finish with the cross-cutting
notifications/polish sweep that touches several earlier phases.

Phases 1, 3, and 4 are independent of one another once Phase 0 lands, so they
can be parallelized across separate Claude sessions if desired.

---

## 5. Cross-cutting conventions

- **Routes:** keep the existing envelope (`handle` / `HttpError` from
  `@/web/api`). New read routes are `GET`, mutations validate membership/role
  via `requireUserForRoute` + `getMembershipRole`.
- **Migrations:** one migration per phase max where possible; name it
  `00NN_<phase_slug>.sql`, hand-written and idempotent (see §1.5 — never
  drizzle-kit generate). List every new table/column in the phase doc.
- **Feature flags:** read through the Phase 0 helper, never check raw columns in
  components.
- **Tests:** every pure service in `src/data/**` gets a Vitest spec, placed in
  `test/` (the vitest `include` is `test/**/*.test.ts`, so co-located
  `src/**/*.spec.ts` files will NOT run). Integration specs use the
  Testcontainers/embedded-Postgres harness in `test/integration/setup.ts`.
- **Service signatures are `db`-first.** Every `src/data/**` service takes the
  `Db` as its first argument, e.g. `getFlags(db, leagueId)` — follow this, not
  the `(leagueId)` shorthand some phase-doc prose uses.
- **Realtime:** reuse the SSE-poll helper from Phase 0; pick a `POLL_MS` that
  matches the surface (chat 2-3s, live stats 15-30s).
- **No secrets in code.** New providers/keys go in `.env.example` with a comment.

---

## 6. Out of scope (explicitly)

- No new stats provider or paid data feed (SofaScore ingest stays as-is).
- No real-money, payments, or wagering.
- No native mobile app (responsive web only).
- No websocket infrastructure (SSE-poll only).


---

## Appendix A — Phase 0 as-built APIs (USE THESE EXACT SIGNATURES)

Phase 0 shipped on `main` (migration `0009_foundations.sql`, applied via
`npm run migrate`). Later phases must import these rather than re-deriving them.
All take `Db` first.

**Notifications** — `src/data/notify/service.ts`
- `enqueue(db, { managerId, type, title, body, leagueId?, link?, channels?, dedupeKey? })`
  — `channels` is an array, e.g. `["IN_APP","EMAIL"]`; IN_APP rows are born
  `SENT`, EMAIL rows `PENDING`. Dedupe is per `(manager, channel, dedupeKey)`,
  so one logical event can fan out to both channels under one key.
- `markRead(db, managerId, id)`
- `listForManager(db, managerId, { unreadOnly?, limit? }) -> { notifications, unreadCount }`
- `deliverPending(db, transport, { managerId?, baseUrl? })` — sends `PENDING`
  EMAIL rows via the transport; no-op if none.
- Transports in `src/data/notify/transport.ts`: `EmailTransport` (interface),
  `ResendTransport`, `RecordingTransport` (tests).

**Realtime** — `src/web/realtime/sse.ts`
- `streamSnapshots<T>({ getSnapshot, pollMs, signal, heartbeatMs?, serialize? }): Response`
  — first-emit + change-only re-emit + heartbeat. Pick `pollMs` per surface
  (chat ~2500, live stats 15000-30000).

**Feature flags** — `src/data/league/feature-flags.ts`
- `FLAGS` = `stats_hub | chat | head_to_head | bracket | survivor | chips | awards`
  (`DEFAULT_FLAGS` = all off). Adding a flag = extend `FLAGS` + `DEFAULT_FLAGS`.
- `getFlags(db, leagueId)`, `getFlagStates(db, leagueId)`,
  `isFlagEnabled(db, leagueId, flag)`, `setFlag(db, leagueId, flag, { enabled, config? })`,
  `isFeatureFlag(value)`. Owner-gated `GET|PUT /api/leagues/[leagueId]/flags`.
  `LeagueTabs` (`app/leagues/[leagueId]/league-tabs.tsx`) renders a tab when its
  flag is on (and a "(soon)" chip until that phase ships a route).

**Stats aggregate** (Phase 1+ build on these) — `src/data/stats/aggregate.ts`
- `topScorers(db, { rulesetVersion, stage?, limit? })`
- `perFixturePlayerPoints(db, rulesetVersion, fixtureId)`
- `statLeaders(db, { metric, stage?, limit? })`
  returning `PlayerPoints` / `PlayerStatTotal`.

**Notification UI** — bell in `app/layout.tsx` (`app/notification-bell.tsx`),
Stats link to `/stats`.

---

## Appendix B — Phase 1 as-built APIs (Stats Hub)

Phase 1 shipped read-only over existing tables (no migration). Phases 2 (player
insights) and 7 (awards) build on these; import them rather than re-deriving.
All `db`-first. The public Hub scores against `HUB_RULESET_VERSION` (=
`DEFAULT_RULESET.version`).

**Stats aggregate** — `src/data/stats/aggregate.ts`
- `topScorers(db, { rulesetVersion, stage?, position?, limit? })`
- `playerForm(db, { rulesetVersion, lastN?, limit? })` — last-N featured fixtures
  by kickoff (tournament-wide, not stage-scoped).
- `bestSingleMatchHauls(db, { rulesetVersion, limit? })` — **Phase 7 reuses this.**
- `nationStatLeaders(db, { metric, limit? })`, `positionScarcity(db, { rulesetVersion })`
- `stagesWithScores(db, rulesetVersion)`, `latestStageWithScores(db, rulesetVersion)`
- Constants `STAGE_ORDER`, `POSITION_ORDER`.

**Team of the Stage** — `src/data/stats/team-of-the-stage.ts`
- `teamOfTheStage(db, { rulesetVersion, stage }) -> TeamOfStage`
- `optimizeGlobalXi(pool) -> BestBallResult | null` (pure; reuses
  `optimizeBestBall` over the global pool).

**Hub composition** — `src/data/stats/hub.ts`
- `getLeaderboards(db, { rulesetVersion, stage?, limit?, formLastN? })`
- `getRecords(db, { rulesetVersion, limit? })`, constant `HUB_METRICS`.

**Cache** — `src/data/stats/cache.ts`
- `memoizeByComputedAt(db, tag, rulesetVersion, compute)`, `latestComputedAt`,
  `clearStatsCache` (process-local memo; fine per Vercel instance).

**Route params** — `src/web/stats-params.ts`
- `HUB_RULESET_VERSION`, `parseStage`, `isStage`.

**Pages/routes:** public `app/stats/**` (no auth) + `GET /api/stats/{team-of-the-
stage/[stage], leaderboards, records}`. The `stats_hub` flag gates only the
per-league nav link (`league-tabs.tsx`), not page access.
## Appendix C — Phase 2 as-built APIs (Player Insights)

Phase 2 shipped read-only over existing tables (no migration, no feature flags).
Cross-league ownership/ADP are pure AGGREGATES — never expose which team/league
owns whom outside the viewer's own league. Import these rather than re-deriving.
All `db`-first.

**Ownership** — `src/data/stats/ownership.ts`
- `globalOwnership(db, { finishedDraftsOnly? }) -> OwnershipResult`
- `ownershipForPlayer(db, playerId, opts?) -> SinglePlayerOwnership`
- `ownershipByPlayerId(db, opts?) -> { totalFantasyTeams, byPlayerId }`
- `finishedDraftsOnly` defaults **true** (numerator + denominator scoped to
  leagues with status `ACTIVE|COMPLETE`).

**ADP / draft analytics** — `src/data/stats/adp.ts`
- `globalAdp(db, { completedDraftsOnly? }) -> AdpResult`
- `adpByPlayerId(db, opts?) -> { totalDrafts, byPlayerId<PlayerAdp> }`
- `PlayerAdp`: `adp, earliestPick, latestPick, timesPicked, takeRate, draftRank,
  reachSteal`. `reachSteal = adp - draftRank` (NEGATIVE = reach / drafted earlier
  than rank; null when unranked; `draft_rank <= 0` treated as unranked).
  `totalDrafts` = drafts with >= 1 pick (or COMPLETE only when `completedDraftsOnly`).

**Differentials / value** — `src/data/stats/differentials.ts`
- `teamInsights(db, { leagueId, teamId, rulesetVersion, templateThreshold?, limit?,
  finishedDraftsOnly? }) -> TeamInsights` — per-team differentials / template /
  best-value. Throws if the team is not in the league. The team page mounts it
  ONLY when `data.managerId === viewer.manager.id` (own team).
- The team page passes the LEAGUE'S OWN `league.scoringRuleset.version` into
  `teamInsights` (with `HUB_RULESET_VERSION` as a fallback if the league row is
  missing), so the panel's "pts" match the rest of the roster page for custom-
  ruleset leagues. (This corrects the agent's original use of `HUB_RULESET_VERSION`
  — relevant since the hash fix `wcf-v1-5c4f7b33` makes positional customization
  produce distinct versions.)

**Hub composition** — `src/data/stats/hub.ts`
- `getDraftTrends(db, { finishedDraftsOnly?, completedDraftsOnly?, limit? }) -> DraftTrends`.

**Reused/extended** — `src/data/stats/aggregate.ts`
- `loadRefs(db, playerIds)` is now exported (returns `Map<number, PlayerRef>`).
- `PlayerBreakdown` (player modal) now carries `ownership` + `adp`;
  `DraftBoardPlayer` now carries `adp` (read-only live overlay in the draft board).

**Pages/routes:** public `GET /api/stats/{ownership, adp}` + public
`app/stats/draft-trends/` (sortable/filterable). Ownership%/ADP columns added to
the Stats Hub leaderboards + the per-league player modal; read-only live-ADP
column in the draft-room player board (autopick logic untouched).

---

## Appendix D — Phase 8 (subset) as-built APIs (Notif prefs + draft polish)

Phase 8 shipped a DELIBERATE SUBSET (phases 3/4/5/6 deferred): notification
preferences, draft pick-queue/autopick, draft-room UI polish, and a mobile/a11y
pass. Migration `0010_notify_prefs_draft_queue.sql` (idempotent) adds two tables.
NOT built: goal/score alerts, deadline reminders, chat in the a11y pass.

**Notification preferences** — `src/data/notify/preferences.ts`
- `allowedChannels(db, managerId, type, requested) -> NotificationChannel[]` — the
  single channel-gate; opt-OUT model (absent row = enabled); a no-op for any
  `type` that is not a managed category. Pure helpers `applyPreferences`,
  `disabledSetFromRows`, `isNotificationCategory`. `getPreferences`/`setPreference`
  drive the UI. `NOTIFICATION_CATEGORIES` / `CATEGORY_LABELS` = the draft
  notification types only (DRAFT_STARTED, ON_THE_CLOCK, PICK_MADE, AUTOPICK_MADE,
  DRAFT_COMPLETE) — extend both when a new notification `type` ships.
- Table `notification_preference (manager_id, category, channel, enabled)` PK
  (manager_id, category, channel).
- Enforcement: the Phase 0 hub `enqueue` filters channels via `allowedChannels`.
  IMPORTANT: nothing actually calls `enqueue` yet, so the live path is the DRAFT's
  own legacy delivery. The interim wiring gates that too —
  `src/data/draft/service.ts` `deliverPending` now calls `allowedChannels(db,
  managerId, type, ["EMAIL"])` and skips (marks SENT) a suppressed draft email.
  When draft notifications migrate onto the hub, that interim gate can be removed.

**Draft pick-queue + autopick** — `src/data/draft/queue.ts`
- `queuedPlayerIds(db, roomId, teamId)`, `getQueue`, `addToQueue`,
  `removeFromQueue`, `reorderQueue`. Table `draft_queue (draft_room_id,
  fantasy_team_id, player_id, rank)` PK(room, team, player) + (room, team, rank) idx.
- `src/data/draft/autopick.ts` `chooseAutopick(counts, available, reqs?, queue?)`
  now takes an optional ordered `queue` and returns `fromQueue`; prefers the
  highest-priority queued, still-available, position-legal player, else falls back
  to `draft_rank`. `src/data/draft/service.ts` `pickAutopickPlayer` loads the
  team's queue (signature gained `draftRoomId`).

**Routes:** `GET|PUT /api/account/notifications` (account-level prefs),
`GET|POST /api/leagues/[leagueId]/draft/queue`.

**UI:** `app/account/notifications/**` (settings); draft `queue-panel.tsx`;
draft-room timer/recent-picks-ticker/best-available hints (best-available uses the
Phase 2 `DraftBoardPlayer.adp`); mobile/a11y pass (focus ring, 44px tap targets,
focusable scroll regions) across league/standings/roster/Stats Hub + draft board.
No new feature flags (prefs are account-level; queue/polish live in the draft room).

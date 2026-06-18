# Phase 2 — Player Insights — ready-to-paste agent prompt

Scope for this hand-off: **FULL Phase 2** — global ownership %, ADP & draft
analytics (public Draft Trends page), differentials/template/value per team, AND
the live-ADP draft-room overlay.

## Orchestrator pre-flight (do these first)
- [ ] Phase 1 (Stats Hub) is committed on `phase-01-stats-hub` and merged to
      `main` as a known-good baseline. Phase 2 builds directly on
      `src/data/stats/aggregate.ts`.
- [ ] This session's scoring fixes are committed too: the `hashRuleset` fix
      (`src/data/scoring/ruleset.ts`) + scoring-test updates + the new
      `scripts/repoint-leagues.ts`. The corrected `DEFAULT_RULESET.version` is
      now `wcf-v1-5c4f7b33`.
- [ ] `npm run migrate` has been run (Phase 0's `0009_foundations.sql` applied).
- [ ] `node --env-file=.env --import tsx scripts/repoint-leagues.ts --apply` has
      been run, so `score_entry` rows exist under the corrected ruleset version.
      Phase 2's "differentials" and "value" read `score_entry` totals — without a
      recompute they would all be zero.
- [ ] `npm run typecheck` and `npm test` are green.
- [ ] `git checkout -b phase-02-player-insights` from up-to-date `main`.

---

## COPY BELOW THIS LINE → paste as the new agent's first message

You are implementing ONE phase of the World Cup Fantasy feature roadmap:
**Phase 2 — Player Insights (Ownership, ADP, Differentials) — the FULL phase.**

Read these before writing any code, in order:
1. `plans/features-2026/PLAN.md` — architecture, conventions, the scoring spine
   you must not break, and **Appendix A** (Phase 0 as-built APIs) + **Appendix B**
   (Phase 1 Stats Hub as-built — the `src/data/stats/aggregate.ts` exports and
   `app/stats/**` patterns you will extend). Note especially §1.5 (migrations are
   HAND-WRITTEN and idempotent — NEVER `drizzle-kit generate` /
   `npm run migrate:generate`) and §5 (specs go in `test/`, services are
   `db`-first).
2. `plans/features-2026/phase-02-player-insights.md` — the phase you will
   implement. Also skim `src/data/db/schema.ts` for `roster_slot`, `draft_pick`
   (`pick_number`), `fantasy_team`, and `player.draft_rank`, plus
   `src/data/draft/` and the existing `app/leagues/[leagueId]/player-stats-modal.tsx`.

Scope — build all of it:
- 2.1 **Global ownership %**: `src/data/stats/ownership.ts` (+ spec) — distinct
  fantasy teams across ALL leagues holding each player (`roster_slot`), and
  `ownershipPct = ownedCount / totalFantasyTeams`. Consider scoping the
  denominator to leagues that have finished drafting.
- 2.2 **ADP & draft analytics**: `src/data/stats/adp.ts` (+ spec) over
  `draft_pick` — mean `pick_number` (ADP), earliest/latest pick, take-rate (% of
  drafts where taken), and reach/steal = ADP minus pre-tournament
  `player.draft_rank` (negative = drafted earlier than rank). Public **Draft
  Trends** page: sortable/filterable (position, nation) table of ADP, ownership %,
  reach/steal.
- 2.3 **Differentials & value**: per fantasy team on the team page
  (`app/leagues/[leagueId]/roster/[teamId]`), a "Your differentials"
  (low-owned, high-`score_entry`-total) / "Template" (high-owned) / "Best value"
  (points per ADP or draft round) panel.
- 2.4 **Live-ADP draft-room overlay**: in an ACTIVE draft room, a READ-ONLY
  overlay showing live ADP next to each available player. Do NOT change autopick
  or pick logic.
- Routes: `GET /api/stats/ownership`, `GET /api/stats/adp`. Add ownership %/ADP
  columns to the player modal + Stats Hub leaderboards.

Hard rules:
- Implement ONLY Phase 2. Do NOT start Phase 3. Stop when the phase's acceptance
  checklist is fully satisfied and `npm run typecheck` + `npm test` are green.
- **Privacy/fairness (acceptance-critical):** ownership and ADP are cross-league,
  so expose ONLY aggregate numbers. Never reveal which specific rival team owns a
  player outside the viewer's own league. The differentials panel must list only
  the viewing manager's own players.
- When reading player point totals for differentials/value, use the current
  ruleset version (`DEFAULT_RULESET.version` / `HUB_RULESET_VERSION` from
  `src/web/stats-params.ts`) — never hard-code a version string. (It is
  `wcf-v1-5c4f7b33` after this session's hash fix, but it must stay derived.)
- Phase 2 is read-only over existing tables, so you most likely need NO migration.
  If you genuinely do, it must be hand-written + idempotent (`0010_*`) per §1.5 —
  confirm the need first. Never edit an existing migration.
- Reuse, don't rebuild: projections already exist in `src/data/projection` (see
  phase doc "Out of scope"); trades/waivers are NOT part of best-ball.
- Pure services in `src/data/stats/**` with Vitest specs in `test/`. Thin route/
  component adapters. `db`-first signatures. The Draft Trends page is PUBLIC (no
  login), like the Stats Hub; per-league panels stay auth-gated.

Workflow:
- Work on the current branch (`phase-02-player-insights`); do not commit to `main`.
- Keep `typecheck` and tests green; add a spec in `test/` alongside each pure
  service. Seed a multi-league fixture so ownership % and ADP are spec-verifiable.
- When done, produce the Completion Report using the template in
  `plans/features-2026/HANDOFF.md`, including a "Deviations from the plan"
  section. Do not merge or open a PR unless asked — just report.

Begin by reading the two docs (including Appendices A and B) and confirming Phase 1
is in place (`src/data/stats/aggregate.ts` exports `topScorers` / `statLeaders`).

## COPY ABOVE THIS LINE

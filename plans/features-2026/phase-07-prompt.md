# Phase 7 — Awards & Trophy Room (derived only) — ready-to-paste agent prompt

Scope for this hand-off: **Phase 7.1 ONLY — derived awards + Trophy Room/Hub UI.**
Deliberately EXCLUDED (do not build): 7.2 bonus/streak/milestone scoring, the
commissioner enable-UI, award-lead notifications, and provisional/lock states.
This keeps Phase 7 read-only and free of any dependency on unbuilt phases.

Selected awards: **Player awards** (Golden Boot / Playmaker / Golden Glove),
**Manager awards** (best single-stage total, best single-XI, best draft value,
best differential haul, most consistent), **Best single-match haul** (per team +
league-wide), and the **Trophy Room page + Stats Hub awards section** to surface
them.

## Orchestrator pre-flight (do these first)
- [ ] Phases 0, 1, and 2 are merged to `main` (Phase 7 reuses Phase 1's stats
      aggregate + Phase 2's ownership/ADP/differentials). Build from current `main`.
- [ ] `npm run typecheck` and `npm test` are green on `main`.
- [ ] No migration is expected for this scope (all awards are derived); `npm run
      migrate` should already be current at `0009_foundations.sql`.
- [ ] `git checkout -b phase-07-awards` from up-to-date `main`.

---

## COPY BELOW THIS LINE → paste as the new agent's first message

You are implementing PART of one phase of the World Cup Fantasy feature roadmap:
**Phase 7.1 — Tournament Awards & Trophy Room (DERIVED awards only).**

Read these before writing any code, in order:
1. `plans/features-2026/PLAN.md` — architecture, conventions, the scoring spine
   you must NOT touch, and **Appendix A** (Phase 0 APIs), **Appendix B** (Phase 1
   stats aggregate — you will reuse `bestSingleMatchHauls`, `topScorers`,
   `statLeaders`, `nationStatLeaders`), and **Appendix C** (Phase 2 — you will
   reuse `teamInsights` for value/differentials and `adp` for draft value). Note
   §1.5 (migrations are HAND-WRITTEN/idempotent — not relevant here, you add none)
   and §5 (specs in `test/`, services `db`-first).
2. `plans/features-2026/phase-07-awards-bonus-scoring.md` — the phase doc. **Build
   ONLY section 7.1 (derived awards) and its Trophy Room / Stats Hub surfaces.**

Scope — build exactly this, all derived (no new writes, no migration):
- `src/data/awards/registry.ts` (+ spec): each award is `{ id, label,
  compute(ctx) }` returning a ranked list. Pure, spec-tested, recomputable.
  Awards to implement:
  - **Player awards** (attributed to the manager who rosters the player): Golden
    Boot = most goals across a team's rostered players; Playmaker = most assists;
    Golden Glove = most clean sheets / saves by that team's keepers. Aggregate
    `stat_line` over `roster_slot` (reuse `statLeaders` / `loadRefs` where useful).
  - **Manager awards**: highest single-stage total and best single-XI (from
    per-stage best-ball standings — see `src/data/standings/standings.ts` +
    `snapshot.ts`); best draft value and best differential haul (reuse Phase 2
    `teamInsights` / `adp` from Appendix C); most consistent = lowest variance of
    per-stage totals (derive from `standings_snapshot` via
    `cumulativeTotalsThroughStage` / `scoredStages` in `snapshot.ts`).
  - **Best single-match haul**: top single-game `score_entry.points` among a
    team's rostered players, surfaced per team AND league-wide. Reuse Phase 1
    `bestSingleMatchHauls` (Appendix B) — do not re-derive it.
- Routes: `GET` per-league Trophy Room (membership-gated) and `GET` global awards
  (public, like the rest of the Stats Hub).
- UI: a per-league **Trophy Room** page rendering current award leaders, and an
  **awards section in the Stats Hub** for the global/player awards. Best-haul
  surfaced per team on the existing team/roster surface.

Ruleset version (important, matches the established pattern):
- The per-league Trophy Room reads each league's OWN ruleset version
  (`league.scoringRuleset.version`), exactly like the roster page's differentials
  panel — so award points match what that league sees elsewhere.
- The global Stats Hub awards read `HUB_RULESET_VERSION` (= `DEFAULT_RULESET.version`,
  currently `wcf-v1-5c4f7b33`). Never hard-code a version string.

Hard rules:
- Implement ONLY the derived awards above. Do NOT build 7.2 (bonus/streak/milestone
  scoring), the commissioner enable-UI, award-lead notifications, or provisional/
  lock states. Stop when these awards + their pages are done and `npm run
  typecheck` + `npm test` are green.
- **Do NOT modify `ruleset.ts`, `score.ts`, or `recompute.ts`.** This scope is
  read-only over existing data; the scoring spine stays byte-for-byte unchanged.
  (NOTE: the ruleset version hash was recently fixed to include nested maps —
  default is now `wcf-v1-5c4f7b33`. Leave it alone.)
- Do NOT depend on anything from the UNBUILT phases — there is no chat/activity
  feed (Phase 3), head-to-head (Phase 4), side games/bracket/survivor (Phase 5),
  or chips (Phase 6). Every award must be computable from already-built data:
  `score_entry`, `stat_line`, `roster_slot`, `fantasy_team`, `standings_snapshot`,
  and the Phase 1/2 services in Appendices B and C. If an award seems to need an
  unbuilt phase, drop it and note it in your report.
- No migration. If you think you need one, STOP and report why first.
- Pure services in `src/data/awards/**` with Vitest specs in `test/`. Thin route/
  component adapters. `db`-first signatures. Each award's ranking must be
  spec-verified against hand-computed expectations on seeded data.

Workflow:
- Work on the current branch (`phase-07-awards`); do not commit to `main`.
- Keep `typecheck` and tests green; add a spec in `test/` alongside the registry.
- When done, produce the Completion Report using the template in
  `plans/features-2026/HANDOFF.md`, including a "Deviations from the plan" section
  (note explicitly that 7.2 and the optional surfaces were intentionally out of
  scope for this hand-off). Do not merge or open a PR unless asked — just report.

Begin by reading the docs (Appendices A/B/C) and confirming Phases 1-2 are in place
(`src/data/stats/aggregate.ts` exports `bestSingleMatchHauls`;
`src/data/stats/differentials.ts` exports `teamInsights`).

## COPY ABOVE THIS LINE

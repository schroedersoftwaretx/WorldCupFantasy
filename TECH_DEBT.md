# Tech Debt Audit — World Cup Fantasy

_Generated 2026-06-22. Static analysis of `app/`, `src/`, `scripts/`, `test/`, and repo hygiene. Priority = (Impact + Risk) × (6 − Effort), each scored 1–5._

Overall the codebase is in good shape: low marker debt (2 `@ts-ignore`, 0 TODO/FIXME), only 11 `any` usages, and 51 test files covering unit/integration/component. The items below are the real drag points, ranked.

| # | Item | Type | Impact | Risk | Effort | Priority |
|---|------|------|:--:|:--:|:--:|:--:|
| 1 | 84 uncommitted files in working tree | Infra/process | 4 | 5 | 1 | **45** |
| 2 | Dead stat-provider code (3 of 5 feeds) | Code/arch | 3 | 3 | 2 | **24** |
| 3 | God modules (6 files 590–907 LOC) | Code | 4 | 3 | 3 | **21** |
| 4 | Documentation sprawl (31 plan/doc files) | Docs | 3 | 2 | 2 | **20** |
| 5 | No structured logging (91 `console.*`) | Infra/obs | 2 | 3 | 3 | **15** |
| 6 | Test/CI gaps (SofaScore unreachable, stale tests) | Test | 3 | 3 | 4 | **12** |
| 7 | Tracked one-off debug script + pre-1.0 deps | Hygiene/dep | 2 | 2 | 2 | **16/verify** |

## Details

**1. 84 uncommitted modified files.** `git status` shows the entire recent feature push sitting unstaged on `main`. Given the recurring pattern of `reset --hard` discarding work in this project, this is the single highest-risk item — one bad reset loses all of it. Commit now on a feature branch. Effort is trivial; risk is severe.

**2. Dead provider code.** Five stat providers exist (`sofascore`, `sportmonks`, `api-football`, `football-data`, `mock`) but SofaScore is the sole production feed. `football-data` and `api-football` mappings (~810 LOC) plus clients are reachable only from the CLI; `sportmonks` (402 LOC + test) is excluded from auto-detect by design. `select.ts` documents *why* each is kept, so this is semi-intentional — but the three unused integrations and their tests are ongoing maintenance and onboarding noise. Decide: keep one documented fallback, delete the rest, or move them behind a clearly-labeled `experimental/` folder.

**3. God modules.** `db/schema.ts` (907), `cli/index.ts` (793), `draft/service.ts` (756), `awards/registry.ts` (722), `draft-room.tsx` (685), `stats/aggregate.ts` (591). These are the files most likely to breed merge conflicts and bugs. Split along natural seams (schema by domain table-group; draft service by command; draft-room into presentational subcomponents) opportunistically as you touch them.

**4. Documentation sprawl.** 11 root-level `.md` files plus 20 in `plans/`, many stale (`PHASE_1_PROMPT.md`, `WEBAPP_PLAN.md`, `phase-03`–`phase-06` are deferred). No single index says what's current vs. historical. Move completed/deferred plans into `plans/archive/` and keep one `STATUS.md` pointer so the next session isn't guessing.

**5. No structured logging.** 91 raw `console.*` calls across `app/` and `src/` mean production errors land in Vercel logs with no level, request id, or structure. Introduce a thin logger wrapper and swap calls in gradually; do API routes and cron handlers first.

**6. Test / CI gaps.** Integration tests need embedded-postgres and the SofaScore ingest can't be reached from cron/CI, so the data path isn't exercised in automation. `sofascore-mapping.test.ts` is noted failing on `main`. There are also full test suites for providers you don't run (see #2). Add a mock-feed smoke test in CI and prune or quarantine the unused-provider suites.

**7. Hygiene & dependencies (verify).** `diagnose-pulisic.mjs`, a one-off debug script, is committed at repo root — delete it. On dependencies, `drizzle-orm ^0.36` / `drizzle-kit ^0.28` are pre-1.0 and `zod ^3.x` has a v4 available; I couldn't reach the npm registry from here to confirm exact lag or CVEs, so run `npm outdated` and `npm audit` before acting. Next is on 15.5.x (current).

## Suggested phasing (alongside feature work)

- **This week (hours):** commit the working tree (#1); delete `diagnose-pulisic.mjs`; run `npm audit`/`npm outdated` (#7).
- **Next sprint (1–2 days):** decide and execute the provider cull (#2); archive stale plans + add `STATUS.md` (#4).
- **Ongoing (as you touch them):** split god modules (#3); introduce the logger and migrate routes/cron first (#5); add a CI mock-feed smoke test and prune dead-provider tests (#6).

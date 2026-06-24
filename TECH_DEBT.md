# Tech Debt — Audit, Progress & Handoff

_Last updated 2026-06-23. This file is self-contained: a new chat should be able to pick up the remaining work from this document alone._

The World Cup Fantasy app (Next.js 15 + React 19 + Drizzle + Postgres; framework-agnostic data layer in `src/data`, a CLI in `src/cli`, web app in `app/`). Priority scoring used below: **(Impact + Risk) × (6 − Effort)**, each 1–5.

---

## 1. Current status snapshot

A `tech-debt-cleanup` branch was built on top of `main` (`85cd6e8`) with the completed fixes. Recommended branch tip is **`d1443c9`** (four solid commits):

| Commit | Item | What |
|--------|------|------|
| `3e0023b` | #7 | remove one-off `diagnose-pulisic.mjs` debug script |
| `c878d58` | #4 | archive 4 completed plan docs into `plans/archive/` + add `STATUS.md` index |
| `b1d2aeb` | #2 | trim unused stat providers (api-football/football-data/sportmonks clients + 2 mappings + sportmonks test); SofaScore is the only production feed; `select.ts` simplified to `sofascore | mock` |
| `d1443c9` | #6 | Docker-free data-path smoke test (`test/unit/smoke-data-path.test.ts`) + `test:smoke` script + `smoke` CI job |

There is a 5th commit `87a229c` (lazy-load auth route in the two unit tests). **It is unnecessary — drop it.** See "Resolved test failures" below for why.

### Test suite state (verified green locally, 2026-06-23)
- `npx vitest run test/component` → **16 files / 71 tests pass**
- `npx vitest run test/unit/rate-limit.test.ts test/unit/validate.test.ts` → **21 pass**
- Integration tests (`test/integration/*`) need Docker (Testcontainers Postgres). They pass on CI (GitHub runners have Docker) and locally only when Docker Desktop is running. This is by design, not a bug.

### Finish applying the completed work (run in your own terminal)
A stale git lock from the cowork session left the branch ref unfinalized. Repair it, then merge:
```powershell
Remove-Item .git\refs\heads\tech-debt-cleanup.lock -ErrorAction SilentlyContinue
git update-ref refs/heads/tech-debt-cleanup d1443c967954f1c3dede3e32b9798ba0ebda15a6
git log --oneline tech-debt-cleanup -5     # confirm the 4 commits on top of 85cd6e8
# after committing any in-flight work on main:
git switch main
git merge tech-debt-cleanup
```

---

## 2. Environment gotchas (important for any future agent session)

- **The cowork/connected-folder mount corrupts files** (null bytes, truncation) and intermittently blocks `.git` writes (refs, reflogs, unlink). Do NOT trust `git status`/diffs seen from a cowork session, and do NOT commit the working tree from one. Build commits from clean `HEAD` blobs via a temp index, or just do git work in a native terminal.
- **`npm ci` deletes `node_modules` first** — on Windows it fails with `EPERM unlink` if a process (dev server, editor, the connected-folder session) holds a native `.node` binary. Prefer **`npm install`** (heals in place) unless you specifically need a clean wipe.
- **A corrupt/partial `node_modules` masquerades as code/test bugs.** A reinstall (`npm install`) is the first thing to try when tests fail to load modules.

---

## 3. Remaining items (prioritized)

| # | Item | Type | Impact | Risk | Effort | Priority | Status |
|---|------|------|:--:|:--:|:--:|:--:|--------|
| 1 | Uncommitted working-tree work at risk | Infra/process | 4 | 5 | 1 | 45 | **Owner-handled** — commit to a branch + push (`phase-08-wip`) |
| 3 | God modules (6 files 590–907 LOC) | Code | 4 | 3 | 3 | 21 | **Open** |
| 5 | No structured logging (91 `console.*`) | Infra/obs | 2 | 3 | 3 | 15 | **Open** |
| 7 | Dependency audit (pre-1.0 drizzle, zod v3) | Dependency | 2 | 2 | 2 | ~16 | **Open** (couldn't run `npm outdated`/`audit` in-session) |
| 2,4,6,7-script | Provider trim, doc archive, smoke test+CI, debug-script removal | — | — | — | — | — | **Done** (branch `tech-debt-cleanup`) |

### Resolved test failures (context — both were one root cause)
The full suite was red on two fronts: (a) `rate-limit.test.ts` + `validate.test.ts` failing with "Failed to load url zod" in `app/api/auth/session/route.ts`, and (b) 16 `css-tree` "createConvertor is not a function" errors in the component tests. **Both were caused by a corrupt/partial `node_modules`**, not by code. A clean reinstall (`npm install`) fixed all of it — the auth route loads and runs fine under vitest, and css-tree parses fine. No code change was needed. (The branch's `87a229c` lazy-import commit was a misdiagnosis-driven change; harmless but drop it.)

### #3 — God modules
Largest files, most likely to breed merge conflicts and bugs: `src/data/db/schema.ts` (907), `src/cli/index.ts` (793), `src/data/draft/service.ts` (756), `src/data/awards/registry.ts` (722), `app/leagues/[leagueId]/draft/draft-room.tsx` (685), `src/data/stats/aggregate.ts` (591). Split along natural seams (schema by domain table-group; draft service by command; draft-room into presentational subcomponents). Behavior-preserving; one file at a time; verify with `npm run typecheck` + `npm test`.

### #5 — Structured logging
91 raw `console.*` calls across `app/` and `src/`. Introduce a thin level-aware logger (debug/info/warn/error + structured fields) that wraps console for now but is swappable for a real backend later. Migrate API routes (`app/api/**/route.ts`) and cron handlers first, then `src/data`. Scope commits per area.

### #7 — Dependency audit
Run `npm outdated` and `npm audit` (needs registry access; wasn't possible from the sandbox). Known pre-1.0 / behind: `drizzle-orm ^0.36`, `drizzle-kit ^0.28`, `zod ^3.x` (v4 exists). `next` is on 15.5.x (current). Assess breaking changes before upgrading; upgrade one package at a time with `npm test` after each.

---

## 4. Ready-to-paste prompts for a new chat

Paste ONE of these to continue a specific item. Each assumes the repo is open and the `tech-debt-cleanup` branch is merged (or note if not).

### Prompt — #3 God modules
```
I'm working on my World Cup Fantasy app (Next.js 15, React 19, Drizzle/Postgres;
data layer in src/data, CLI in src/cli, web in app/). I want to tackle tech-debt
item #3: oversized "god module" files. The worst offenders (LOC): src/data/db/schema.ts
907, src/cli/index.ts 793, src/data/draft/service.ts 756, src/data/awards/registry.ts
722, app/leagues/[leagueId]/draft/draft-room.tsx 685, src/data/stats/aggregate.ts 591.

Start with src/data/db/schema.ts. Propose a split into multiple files grouped by
domain (e.g. leagues, drafts, fixtures/stats, notifications), keeping a barrel that
re-exports everything so no import path elsewhere changes. The change must be
behavior-preserving. After the split, run `npm run typecheck` and `npm test` and
confirm green. Work on a branch, commit incrementally, and do the git work / file
edits in my terminal+editor (not via the connected-folder mount, which corrupts
files). Don't touch the other large files until I approve the first one.
```

### Prompt — #5 Structured logging
```
World Cup Fantasy app (Next.js 15, data layer in src/data, web in app/). Tech-debt
item #5: replace the ~91 raw console.* calls across app/ and src/ with a structured
logger. 

Step 1: create a small logger (e.g. src/web/logger.ts) with levels
(debug/info/warn/error) and structured fields ({msg, ...context}); for now it can
wrap console, but the call sites should be backend-swappable. Propose the interface
first and show me one migrated API route as the pattern.

Step 2 (after I approve): migrate app/api/**/route.ts and the cron handlers first,
then src/data. Keep commits scoped per area and run `npm run typecheck` + `npm test`
after each. Note: don't edit through the connected-folder mount (it corrupts files) —
do edits in my editor/terminal.
```

### Prompt — #7 Dependency audit
```
World Cup Fantasy app. Tech-debt item #7: dependency audit. Run `npm outdated` and
`npm audit` and summarize what's outdated and what has advisories. Pay attention to:
drizzle-orm (^0.36) and drizzle-kit (^0.28) being pre-1.0, zod (^3.x; v4 exists), and
confirm next (15.5.x) is current. For each upgrade candidate, tell me the breaking
changes from its changelog and the risk level, then propose a safe upgrade ORDER.
Don't upgrade anything until I approve; then upgrade one package at a time and run
`npm test` after each. Drizzle and zod majors are the risky ones — flag those clearly.
```

### Prompt — verify/merge the existing cleanup branch (if not yet merged)
```
World Cup Fantasy app. I have a branch `tech-debt-cleanup` (tip d1443c9) with four
tech-debt fixes on top of main (85cd6e8): removed a debug script, archived docs +
added STATUS.md, trimmed unused stat providers (SofaScore is the only production
feed; select.ts is now sofascore|mock), and added a Docker-free smoke test + CI job.
Help me review `git diff main..tech-debt-cleanup`, run `npm run typecheck` and
`npm test` to confirm green, and merge it into main. If the branch ref is missing,
recreate it with: git update-ref refs/heads/tech-debt-cleanup d1443c967954f1c3dede3e32b9798ba0ebda15a6
```

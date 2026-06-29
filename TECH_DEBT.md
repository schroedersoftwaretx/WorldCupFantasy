# Tech Debt — Audit, Progress & Handoff

_Last updated 2026-06-28. This file is self-contained: a new chat should be able to pick up the remaining work from this document alone._

The World Cup Fantasy app (Next.js 15 + React 19 + Drizzle + Postgres; framework-agnostic data layer in `src/data`, a CLI in `src/cli`, web app in `app/`). Priority scoring used below: **(Impact + Risk) × (6 − Effort)**, each 1–5.

---

## 1. Current status snapshot

The original `tech-debt-cleanup` branch is **merged into `main`**. Since then, item **#3 (god modules) has also been completed and merged** — schema, CLI, draft service, awards registry, and draft-room were each split behind barrels in separate PRs (main is at `2e17887`). The earlier cleanup batch (provider trim, doc archive, smoke test + CI, debug-script removal) is also in `main`.

### Test suite state (verified green in sandbox harness, 2026-06-28)
- `npx vitest run test/component test/unit/rate-limit.test.ts test/unit/validate.test.ts` → **18 files / 92 tests pass**
- `npm run typecheck` → **0 errors**
- Integration tests (`test/integration/*`) need Docker (Testcontainers Postgres). They pass on CI (GitHub runners have Docker) and locally only when Docker Desktop is running. This is by design, not a bug.

---

## 2. Environment gotchas (important for any future agent session)

- **The cowork/connected-folder mount corrupts files** (null bytes, truncation) and intermittently blocks `.git` writes (refs, reflogs, unlink). Do NOT trust `git status`/diffs seen from a cowork session, and do NOT commit the working tree from one. Build commits from clean `HEAD` blobs via a temp index, or just do git work in a native terminal.
- **`npm install` cannot run against the repo through the mount** — do dependency work in a `/tmp` harness (`git archive HEAD | tar -x -C /tmp/up`, install there, deliver `package.json` + `package-lock.json` to apply natively).
- **`npm ci` deletes `node_modules` first** — on Windows it fails with `EPERM unlink` if a process holds a native `.node` binary. Prefer **`npm install`** (heals in place) unless you specifically need a clean wipe.
- **A corrupt/partial `node_modules` masquerades as code/test bugs.** A reinstall (`npm install`) is the first thing to try when tests fail to load modules.
- **Sandbox harness note:** files created in one bash call get squashed to `nobody` ownership in later calls, and backgrounded processes don't survive across calls — so each install/gate pipeline must complete inside a single bash call.

---

## 3. Remaining items (prioritized)

| # | Item | Type | Impact | Risk | Effort | Priority | Status |
|---|------|------|:--:|:--:|:--:|:--:|--------|
| 5 | No structured logging (92 `console.*` across 22 files) | Infra/obs | 2 | 3 | 3 | 15 | **Open** |
| 8 | Drizzle migration meta-snapshot drift | Dependency/DB | 3 | 3 | 2 | ~24 | **Fix delivered** — apply with #7 (`outputs/meta-fix/`) |
| 3 | God modules | Code | 4 | 3 | 3 | 21 | **Done** — split + merged; only `src/data/stats/aggregate.ts` (569 LOC) remains as an optional sliver |
| 7 | Dependency audit + upgrade | Dependency | 2 | 2 | 2 | ~16 | **Audit done; upgrade EXECUTED & delivered** — pending owner apply on Windows |
| 1,2,4,6,7-script | WIP commit, provider trim, doc archive, smoke test+CI, debug-script removal | — | — | — | — | — | **Done** (merged) |

### #5 — Structured logging (Open)
92 raw `console.*` calls across 22 files in `app/` and `src/`. Introduce a thin level-aware logger (debug/info/warn/error + structured fields) that wraps console for now but is swappable for a real backend later. Migrate API routes (`app/api/**/route.ts`) and cron handlers first, then `src/data`. Scope commits per area. Ready-to-paste prompt below.

### #8 — Drizzle migration meta-snapshot drift (Fix delivered 2026-06-28)
`drizzle-kit generate` emitted a spurious migration that recreates objects which already exist in earlier migrations (`draft_queue`, `notification_preference` from `0010`; `stat_line.key_passes` / `big_chances_created` from `0011`). Root cause: **`drizzle/meta/` was missing its snapshot chain head** — it only contained `0005_snapshot.json` and `0009_snapshot.json` (effective chain genesis→0005→0009), so drizzle-kit diffed the live schema against stale `0009` state.

**Fix (delivered):** the missing head snapshot **`drizzle/meta/0011_snapshot.json`** — a full serialization of the current schema (23 tables), chained to `0009`'s id. With it in place, `drizzle-kit generate` prints *"No schema changes, nothing to migrate"* (verified in the harness under drizzle-kit 0.31.10, stable across two runs; 12 SQL files unchanged; journal untouched). The file + apply steps are in **`outputs/meta-fix/`** (`drizzle/meta/0011_snapshot.json` + `APPLY.md`).

**Apply together with #7.** The currently-committed drizzle-kit 0.28.x can't even load the post-#3-split schema (`Cannot find module './schema/enums.js'`), so `generate` only works after the 0.31.10 upgrade. Sequence: apply #7, drop in the snapshot, run `npx drizzle-kit generate` to confirm it's empty, commit.

Pre-existing, harmless gap: snapshots for `0000–0008` and `0010` remain absent. Runtime `drizzle-kit migrate` uses the SQL files + journal (not snapshots), and `generate` only reads the head snapshot — so this doesn't affect anything. Fix later only if full historical snapshot tooling is needed.

### #3 — God modules (Done)
All six original offenders were split behind barrels and merged: `schema.ts` 907→29, `cli/index.ts` 793→135, `draft/service.ts` 756→39, `awards/registry.ts` 722→142, `draft-room.tsx` 685→412, `stats/aggregate.ts` 591→569. Only `src/data/stats/aggregate.ts` is barely reduced (569 LOC) — split it along natural seams if you want to close this fully, but it's optional.

### #7 — Dependency audit + upgrade (Audit done; upgrade executed & delivered)
Audit complete and verified. The headline finding — drizzle SQL-injection advisory **CVE-2026-39356 / GHSA-gpj5-g38j-94v9** (CVSS 7.5 high, fixed in drizzle-orm 0.45.2) — was independently confirmed against the live advisory; practical exposure here is low (no `sql.identifier` / `sql.raw` / dynamic `.as()` in the repo).

**Upgrade executed 2026-06-28** in a `/tmp` harness; gates green (typecheck 0 errors, vitest 18 files / 92 tests). Delivered as `outputs/dep-upgrade/package.json` + `package-lock.json` to apply natively (re-run `npm install` on Windows, run gates, commit). Full version pins and the re-usable two-batch prompt live in **`plans/dependency-upgrade-prompt.md`**. Summary of what changed:
- **drizzle-orm 0.36 → 0.45.2** and **drizzle-kit 0.28 → 0.31.10** (security pair, version-coupled).
- Safe patches/minors: next 15.1 → 15.5.19 (stayed on 15), pg 8.13 → 8.22, react/react-dom 19.0 → 19.2.7, @types/* bumped (node held on 22.x), tsx 4.19 → 4.22.4, playwright 1.60 → 1.61.1.
- **Deferred by decision (untouched):** zod (3.x; v4 is a major), next 16, typescript 6, vitest, firebase, firebase-admin, resend, testcontainers.
- **drizzle-kit generate flagged drift, not a bump issue** → see item #8. The spurious migration was discarded; no migration is part of the delivery.

---

## 4. Ready-to-paste prompts for a new chat

### Prompt — #5 Structured logging
```
World Cup Fantasy app (Next.js 15, data layer in src/data, web in app/). Tech-debt
item #5: replace the ~92 raw console.* calls across app/ and src/ with a structured
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

### Prompt — #8 Drizzle migration meta-snapshot drift (fix already delivered)
The head-snapshot fix is delivered in `outputs/meta-fix/` (drop `drizzle/meta/0011_snapshot.json`
in, apply with #7, run `npx drizzle-kit generate` to confirm it's empty). Only use the prompt
below if you later want to also rebuild the deeper historical snapshots (0000–0008, 0010),
which are a harmless pre-existing gap:
```
World Cup Fantasy app (Drizzle + Postgres). The drizzle/meta snapshot chain is missing
its historical snapshots (only 0005, 0009, and the restored 0011 head exist). The head
is fine and `drizzle-kit generate` is clean. Optionally rebuild the intermediate snapshots
(0000–0008, 0010) so the full chain is intact, without changing any migration SQL or the
journal, and without emitting any migration that recreates existing objects. Work in my
terminal (the mount corrupts files), commit incrementally.
```

### Prompt — #7 dependency upgrade (already executed; see plans/dependency-upgrade-prompt.md)
The two-batch upgrade-execution prompt and its 2026-06-28 results are saved in
`plans/dependency-upgrade-prompt.md`. Re-use it for the next upgrade round (e.g. when
tackling the deferred zod 4 / next 16 / typescript 6 majors — do those one at a time, alone, last).

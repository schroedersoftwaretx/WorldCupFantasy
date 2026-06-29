# Tech-debt #7 — dependency upgrade-execution prompt

_Originally drafted in chat 2026-06-27 (it lived only in that conversation; saved here so
it isn't lost). **EXECUTED 2026-06-28** — see "Execution results" at the bottom. Re-usable
as-is for the next round of upgrades._

## Context
World Cup Fantasy app (Next.js 15, React 19, Drizzle/Postgres). This is the EXECUTION of
tech-debt #7, following the completed audit. The audit independently verified the drizzle
SQL-injection advisory **CVE-2026-39356 / GHSA-gpj5-g38j-94v9** (CVSS 7.5 high, improper
escaping of quoted SQL identifiers, fixed in drizzle-orm 0.45.2). Practical exposure here is
low: the repo uses no `sql.identifier`, no `sql.raw`, and no dynamic `.as()` — but it's a
cheap, high-severity fix worth taking.

## Scope rules
Do ONLY the two batches below. Do NOT touch: zod (stay on 3.x), next 16, typescript 6,
firebase-admin, firebase, resend, testcontainers, or vitest — those are deferred by decision.

## Environment
Registry IS reachable from the cowork sandbox, but the connected-folder mount corrupts
writes and `npm install` fails in the mount. So do NOT modify the repo in place. Work in a
`/tmp` harness: `git archive HEAD | tar -x -C /tmp/up` for a clean tree, `npm install`
there, make the version bumps there, regenerate the lockfile there, run gates there. Then
DELIVER the updated `package.json` + `package-lock.json` for the owner to apply on their
Windows machine (re-run `npm install` on Windows to reconcile native binaries) + run their
own gates + commit.

## BATCH 1 — safe patches/minors
Bump to latest within range (all low-risk): pg, react, react-dom, @types/* (keep
@types/node on the 22.x line), tsx, playwright, and next 15.5.x (patch only; do NOT go to
16). Then gate:
- `npm run typecheck` (must be 0 errors)
- `npx vitest run test/component test/unit/rate-limit.test.ts test/unit/validate.test.ts`
  (must pass)

## BATCH 2 — drizzle security pair
Upgrade drizzle-orm -> 0.45.2 AND drizzle-kit -> latest 0.31.x TOGETHER (version-coupled;
0.45.2 fixes CVE-2026-39356). After install:
- Run `drizzle-kit generate` and REPORT whether it produces a new migration and exactly
  what's in it. drizzle-kit >=0.30 stops emitting `IF NOT EXISTS` in new DDL — confirm any
  generated diff is ONLY that cosmetic change and touches no table/column/index. Do NOT
  invent or commit a migration; if it wants to emit a non-trivial schema change, STOP and
  flag it — that means drift, not the bump.
- Gate: `npm run typecheck` + the same vitest subset.

## General rules
Change ONLY dependency versions — no source edits. Pin to exact resolved versions in the
report. If any gate fails, STOP and report rather than working around it.

---

## Execution results (2026-06-28)
Ran in a Linux `/tmp` harness (`git archive HEAD` from main @ `2e17887`). Both batches done
in one tree; gates green.

**Versions delivered** (package.json range -> installed):
- drizzle-orm  `^0.36.0` -> **`0.45.2`** (CVE-2026-39356 fix)  [installed 0.45.2]
- drizzle-kit  `^0.28.0` -> **`0.31.10`**                       [installed 0.31.10]
- next         `^15.1.0` -> `^15.5.19`  [15.5.19 — stayed on 15, NOT 16]
- pg           `^8.13.0` -> `^8.22.0`   [8.22.0]
- react        `^19.0.0` -> `^19.2.7`   [19.2.7]
- react-dom    `^19.0.0` -> `^19.2.7`   [19.2.7]
- @types/node  `^22.7.0` -> `^22.20.0`  [22.20.0 — held on 22.x line]
- @types/pg    `^8.11.10` -> `^8.20.0`  [8.20.0]
- @types/react `^19.0.0` -> `^19.2.17`  [19.2.17]
- @types/react-dom `^19.0.0` -> `^19.2.3` [19.2.3]
- tsx          `^4.19.0` -> `^4.22.4`   [4.22.4]
- playwright   `^1.60.0` -> `^1.61.1`   [1.61.1]
- Untouched (deferred): zod ^3.25.76, typescript ^5.6.0, vitest ^2.1.0, firebase,
  firebase-admin, resend, testcontainers, jsdom, @testing-library/*, playwright-extra.

**Gates:** `npm run typecheck` PASS (0 errors). `npx vitest run test/component
test/unit/rate-limit.test.ts test/unit/validate.test.ts` PASS — 18 files / 92 tests.

**drizzle-kit generate — STOPPED & FLAGGED (drift, not the bump).** generate emitted a
non-cosmetic migration `0012` recreating `draft_queue`, `notification_preference`, and
`stat_line.key_passes` / `stat_line.big_chances_created`. Those objects ALREADY exist in
migrations `0010` and `0011`. Root cause is PRE-EXISTING meta-snapshot drift: `drizzle/meta/`
only contains `0005_snapshot.json` and `0009_snapshot.json` — the snapshots for 0006–0008,
0010, 0011 are missing, so drizzle-kit diffs the schema against stale `0009` state and
re-emits already-applied objects. This happens with ANY drizzle-kit version and is unrelated
to the upgrade. The spurious `0012` was DISCARDED and is NOT part of the delivered files.
This is tracked as tech-debt item #8 in TECH_DEBT.md.

**Delivered files:** `outputs/dep-upgrade/package.json` + `outputs/dep-upgrade/package-lock.json`
(apply on Windows, re-run `npm install`, run gates, commit). No source or migration files changed.

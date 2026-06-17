# Hand-off Guide — running the build with multiple agents

This is the operating manual for implementing the phased plan in this folder.
One agent implements one phase, on its own branch, and returns a completion
report. You orchestrate; the planning conversation reviews reports and patches
downstream phase docs between phases.

---

## Golden rules

1. **One agent per phase.** Never run a single agent across multiple phases —
   context drifts and early mistakes poison later phases.
2. **Fresh agent, two docs.** Each agent gets `PLAN.md` + exactly one
   `phase-0X-*.md`. Nothing else from prior agents' context.
3. **Phase 0 first.** Everything depends on it. Finish and merge it before
   starting any other phase.
4. **Branch per phase.** Each agent works on its own git branch; merge one at a
   time after review. (Parallelize 1/3/4 only if you're comfortable resolving
   merges; otherwise go sequential.)
5. **Stop at the boundary.** The agent implements only its phase and stops — it
   does not start the next one.
6. **Green gate.** A phase is done only when its acceptance checklist passes and
   `npm run typecheck` + `npm test` are green.

---

## Before you start (one time)

- [ ] Apply any pending migrations with `npm run migrate` (Phase 0 added
      `0009_foundations.sql`) so the DB matches the schema.
- [ ] Confirm `npm run typecheck` and `npm test` are green on `main`.
- [ ] Commit/clean the working tree so every phase starts from a known-good
      baseline. A later failure is then unambiguously that phase's.

---

## Recommended build order

`0 → 1 → 3 → 2 → 4 → 7 → 6 → 5 → 8`

Phases 1, 3, and 4 are independent once 0 is merged and can be parallelized
across separate agents/branches if desired.

---

## The loop, per phase

1. Create a branch: `git checkout -b phase-0X-<slug>` from up-to-date `main`.
2. Start a **new** agent with the prompt template below (fill in the phase).
3. Agent implements the phase and returns the **completion report**.
4. **Review before merge:** run a separate review pass (use the
   `engineering:code-review` skill / a fresh reviewer agent) over the diff.
5. Bring the completion report back to the planning conversation. It will:
   sanity-check against the plan, and **patch the downstream phase docs** to
   match what actually got built.
6. Merge the branch into `main`.
7. New branch + new agent for the next phase.

---

## Copy-paste: phase agent prompt

> Replace `<N>`, `<SLUG>`, and the path. Paste this as the agent's first message.

```
You are implementing ONE phase of the World Cup Fantasy feature roadmap.

Read these two files before writing any code, in order:
1. plans/features-2026/PLAN.md  — architecture, conventions, the scoring spine
   you must not break, and the data-layer/web split.
2. plans/features-2026/phase-0<N>-<SLUG>.md  — the phase you will implement.

Scope rules:
- Implement ONLY this phase. Do NOT start the next phase. Stop when the phase's
  acceptance checklist is fully satisfied.
- Confirm this phase's prerequisites are already merged before starting; if not,
  stop and report that.
- Follow the conventions in PLAN.md exactly: pure services in src/data/** with
  Vitest specs in test/ (NOT co-located — see PLAN.md §5), thin route/component
  adapters, db-first service signatures, feature-flag gating, idempotent writes.
- Migrations are HAND-WRITTEN and idempotent (CREATE TABLE IF NOT EXISTS, guarded
  CREATE TYPE). Do NOT run drizzle-kit generate / npm run migrate:generate — it
  emits broken drift in this repo (PLAN.md §1.5). Never edit an existing migration.
- Do not break the stat_line -> score_entry -> standings spine. Anything that can
  be derived should be derived, not stored.

Workflow:
- Work on the current git branch only.
- Write tests alongside each pure service. Keep `npm run typecheck` and
  `npm test` green.
- When done, produce the Completion Report using the template in
  plans/features-2026/HANDOFF.md. Do not merge or open a PR yourself unless I
  ask — just report.

Begin by reading the two docs and confirming the prerequisites are in place.
```

---

## Copy-paste: completion report template

> The agent fills this in and returns it as its final message.

```
# Phase 0<N> — <SLUG> — Completion Report

## Status
- Acceptance checklist: <PASS / PARTIAL> (details below)
- typecheck: <pass/fail>   tests: <pass/fail, N passed / M total>

## Acceptance checklist (from the phase doc)
- [ ] <item 1> — <how verified>
- [ ] <item 2> — <how verified>
- ... (every box from the phase doc, each with a verification note)

## What changed
- Migration added: <00NN_name.sql> (append-only: yes/no)
- New tables/columns: <list>
- New services (src/data/**) + specs: <list>
- Routes added/changed: <list>
- UI added/changed: <list>

## Deviations from the plan
- <anything done differently than the phase doc, and WHY>
- <naming/shape differences a downstream phase needs to know about>
- (Write "none" only if truly none.)

## Follow-ups / new tech debt
- <anything noticed but intentionally out of scope>

## Hand-off pointers for later phases
- <new helper/service names + signatures other phases will import>
- <feature flags introduced>

## Branch / diff
- Branch: <name>   Files touched: <count>
- (PR/diff link if applicable)
```

---

## What the planning conversation does with the report

- Confirms the acceptance checklist and green gate.
- Reconciles **Deviations** against the downstream phase docs and edits those
  docs so the next agent works from reality, not the original assumption
  (e.g. renamed services, changed table shapes, flags added).
- Flags any follow-ups worth turning into their own small task.

Bring each completed phase's report back before starting the next phase.

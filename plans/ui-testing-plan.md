# UI Layer Testing Plan & Coverage Map

**Status (2026-06-22): in good shape.** The `app/` React layer went from zero coverage to
**71 tests across 16 files** (`test/component/`), all passing. This doc records what's covered,
how the harness works, and what's left — so the next person can pick up without re-deriving it.

---

## Harness & conventions

The data layer keeps its existing Node + Testcontainers suites unchanged. Component tests run
alongside them but opt into a DOM, so the two never interfere.

- **Location:** `test/component/*.test.tsx`.
- **Environment:** each file opts into jsdom with a top-of-file docblock `// @vitest-environment jsdom`.
  The default Vitest environment stays `node`, so the Testcontainers integration suites are untouched.
- **Setup:** `test/component/setup.ts` wires up `@testing-library/jest-dom` matchers + RTL cleanup.
  It is imported by component tests only — never registered as a global `setupFiles` — so it can't
  crash the node suites.
- **Dev deps:** `@testing-library/react`, `@testing-library/user-event`, `@testing-library/jest-dom`,
  `jsdom`.
- **Mock at the boundary:** `fetch`, `EventSource`, `Notification`, `next/link`, `next/navigation`.
  No test hits a real server or database.
- **Fixtures** are built from the real types in `src/web/api-types.ts` and the data-layer types, so
  they stay honest as the API shape evolves.
- **Style:** behaviour-focused — assert what a user sees (rendered text, what appears/disappears after
  an interaction) using accessible queries (`getByRole`, `getByText`) over test IDs.

When adding a test, read an existing one first (`draft-room-effects.test.tsx`, `roster-pitch.test.tsx`,
`best-lineup.test.tsx` are good templates) and match its style.

---

## Covered

| Test file | Component(s) | What it asserts |
|---|---|---|
| `roster-pitch.test.tsx` | `roster/[teamId]/roster-pitch.tsx` | Week selector switches the pitch; best-ball XI rows highlighted; per-week G/A/Pts table; `tfoot` totals sum only XI rows; the "All" whole-tournament view. |
| `best-lineup.test.tsx` | `draft/best-lineup.tsx` (`PitchSvg`) | Filled pitch circles are `role="button"` that open the stats modal and fetch the breakdown when inside `PlayerStatsProvider`; empty placeholders are inert; with no provider the circles are inert. |
| `player-board.test.tsx` | `draft/player-board.tsx` | Per-column sorting; filters change visible rows; draft-button gated on your-pick / draftable state. |
| `standings-period-table.test.tsx` | `standings/standings-period-table.tsx` | Expanding a cell reveals that team's XI for the period; Escape / backdrop close; lazy breakdown fetch. |
| `player-stats-modal.test.tsx` | `player-stats-modal.tsx` | Opening a player opens the modal, fetches the breakdown, and closes on Escape / backdrop. |
| `queue-panel.test.tsx` | `draft/queue-panel.tsx` | Queue add / remove / reorder controls. |
| `draft-room.test.tsx` | `draft/draft-room.tsx` | Real-time pick ticker over a mocked SSE `EventSource` (+ `fetch`). |
| `draft-room-effects.test.tsx` | `draft/draft-room.tsx` | Polling fallback when `EventSource` is undefined (`setInterval` on `POLL_MS`, re-renders on new state); on-clock flips `document.title` and fires `new Notification(…)` when granted, then resets the title off-clock. |
| `draft-room-flows.test.tsx` | `draft/draft-room.tsx` | `NONE` owner sees the setup form, create POSTs `/draft` then advances to start; `PENDING` owner starts via `/draft/start`; start disabled with a hint under 2 managers; non-owners see waiting notices (owner-only gating). |
| `scoring-rules.test.tsx` | `draft/scoring-rules.tsx` | Rule rows render the ruleset's point values; `<details>` collapsed by default and toggles via `<summary>`. |
| `scoring-editor.test.tsx` | `scoring/scoring-editor.tsx` | Editing scoring-rule inputs. |
| `create-league-form.test.tsx` | `create-league-form.tsx` | Create-league form submit / validation. |
| `rename-team-form.test.tsx` | `rename-team-form.tsx` | Team rename submit. |
| `features-panel.test.tsx` | `settings/features-panel.tsx` | Feature-flag toggles. |
| `notification-bell.test.tsx` | `notification-bell.tsx` | Bell dropdown / unread state. |
| `trends-table.test.tsx` | `stats/draft-trends/trends-table.tsx` | Draft-trends table render / sort. |

---

## Not yet covered

### Within already-tested components (minor edge/recovery paths)
- **draft-room SSE transitions:** the error → reconnect / `CLOSED` → polling fallback path (only the
  no-`EventSource` fallback is exercised).
- **draft-room recovery controls:** the "Stuck?" / `/draft/tick` / `force-pick` controls.
- **draft-room `COMPLETE` status:** the post-draft summary view.

### Client components with no tests yet (priority order)
1. `account/notifications/notification-settings.tsx` — preference toggles + save (user-facing).
2. `standings/recompute-button.tsx` — owner recompute action + pending/disabled state.
3. `invite/[token]/join-button.tsx` and `leagues/[leagueId]/invite-panel.tsx` — invite generate / accept.
4. `stats/stage-pitch-marker.tsx` — pitch marker interaction on the public hub.
5. `sign-out-button.tsx`, `login/page.tsx` — auth surface (sign-in/out trigger; mock Firebase client).
6. `admin/stats/[fixtureId]/stat-editor.tsx` — admin-only stat editing (lower traffic).
7. Route boundaries `error.tsx` / `global-error.tsx` / `not-found.tsx` — assert the `reset()` action
   and recovery links render (low value, quick).

### Out of scope here
- **Async Server Components** (the pages themselves) — React Testing Library can't render these; they
  stay covered by the data-layer integration suites in `test/integration/`.
- **Pure lineup math** — already covered in `test/unit/best-lineup.test.ts`; don't duplicate.

---

## How to run & verify

- `npm test` runs everything (component + unit + integration); `npm run typecheck` typechecks the test
  files too.
- **Sandbox caveat:** the Cowork FUSE mount is degraded and truncates working-tree source, so `vitest`
  and `tsc` die with `Bus error` against the mounted tree. To get a real signal, build a clean tree
  with `git archive HEAD` on the sandbox's real filesystem and run there. (This is a sandbox-only
  quirk — it does not affect a normal checkout.)
- **Durable signal:** CI (`.github/workflows/ci.yml`) runs `npm test` + `npm run typecheck` + build on
  a clean Linux checkout for every push/PR. Treat the green **Tests** job as the source of truth.

---

## Suggested next steps
1. Close the three draft-room edge paths above (SSE reconnect, recovery controls, `COMPLETE` view).
2. Cover `notification-settings.tsx` and `recompute-button.tsx` (highest-traffic untested actions).
3. Add the invite flow (`join-button.tsx` + `invite-panel.tsx`).
4. Once required-status-checks are enabled on `main`, keep this map updated as files land.

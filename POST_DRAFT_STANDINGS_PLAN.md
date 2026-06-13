# Fantasy World Cup — Post-Draft & Standings Improvement Plan

Quality-of-life features that bring the post-draft experience and the
standings view up to par with ESPN / Yahoo / Sleeper / FPL. Each item is
self-contained enough to hand off as its own build prompt.

The big opportunities, in one sentence each:
- **Post-draft is a dead end today** — finishing the draft drops you on a
  one-line "Draft complete" banner. Every major app turns this moment into a
  *recap*: a full draft board grid, grades, and "best value / biggest reach"
  callouts. This is the highest-leverage area.
- **Standings are a static snapshot** — they show totals but no *movement,
  trend, or survivorship*. In a World Cup the killer signal is "how many of
  my players are still alive," which we can compute from data we already have.

What we can build on (already in the codebase, no new data pipeline needed):
- `projectedPoints` per player (`src/data/projection/project-points.ts`)
- league-wide ownership via `src/data/projection/player-shares.ts`
- `stageProbabilities` per player (`stage_odds`, The Odds API)
- best-ball XI per team per period (`computeStandings`, standings-period-table)
- country flags (`src/web/flags.ts` → flagcdn `<img>`)
- per-period score breakdown + tie-breakers (`StandingsEntry`)

---

## Part A — Post-Draft Recap

### A1. Draft Results / Recap page ⭐ (highest impact)

**What:** When a draft completes, `draft-room.tsx` shows only a
`.draft-banner.done` line linking to standings. There is no record of *who
took whom, in what order*. This is the single biggest gap vs every other
fantasy app.

**Goal:** A dedicated `/leagues/[leagueId]/draft/results` page (linked from
the completion banner and the league home) showing the classic **snake-draft
board grid**: rounds down the rows, teams across the columns, each cell a
pick (player name, position, national-team flag). Color-code cells by
position (GK/DEF/MID/FWD). This is the artifact people screenshot and share.

**Steps:**
1. New query in `src/web/` returning every pick ordered by pick number, with
   player name, position, national team, round, and the drafting team — the
   pick log already exists (`DraftPickLog`); just need it for a completed
   draft, unfiltered.
2. New page `app/leagues/[leagueId]/draft/results/page.tsx`: render a grid
   (teams = columns, rounds = rows). Honor snake order so the eye can follow
   the serpentine. Reuse `flagImg` for the flag.
3. Position color classes in `globals.css` (`.pick-gk/.pick-def/...`).
4. Below the grid, a per-team roster recap (collapsible) grouped by position.
5. Link it from the completion banner ("View draft results →") and the
   league home page once `draftStatus === "COMPLETE"`.

---

### A2. Draft Grades + Value/Reach callouts ⭐

**What:** `projectedPoints` is computed and shown live in the draft board but
thrown away the moment the draft ends. ESPN/Yahoo's most-clicked post-draft
feature is the **letter grade** and the **steal/reach** list.

**Goal:** On the results page (A1), grade each team and surface the draft's
best values and biggest reaches.

**Steps:**
1. **Team grade:** sum each team's drafted `projectedPoints`, rank teams, and
   map to a curve (A+ … F) relative to the league mean/stdev. Show the grade
   and projected total on each column header of the results grid.
2. **Value score per pick:** compare a player's *projected rank* to the
   *pick number* they went at. `value = projectedRank − overallPickNumber`.
   Large positive = a steal (great player taken late); large negative = a
   reach.
3. Render two short lists: "🔥 Best values" (top 5 by value) and "🧊 Biggest
   reaches" (bottom 5), each with team, player, pick #, projected rank.
4. Keep all of this server-computed and read-only; it's a derived view of
   data already in the DB.

---

### A3. Pre-tournament Projected Standings

**What:** Between the draft ending and the first match, the standings page is
all zeros — there's nothing to look at, so people stop opening the app.

**Goal:** Show a **projected leaderboard** before any real points exist,
ranking teams by the sum of their best-ball-eligible projected points (and
optionally each team's aggregate `stageProbabilities` as an "upside"
column).

**Steps:**
1. When `computeStandings` returns all-zero totals (tournament not started),
   fall back to a projected ranking computed from `projectedPoints`.
2. Add a clearly-labeled "Projected" badge so nobody confuses it with real
   standings.
3. Optional "Title odds" column: aggregate the CHAMPION `stageProbabilities`
   of each team's roster as a rough deep-run indicator.

---

### A4. Shareable draft recap card

**What:** Sleeper/Yahoo generate a one-image recap people post to group
chats. Drives the viral loop that keeps a league engaged.

**Goal:** A single self-contained recap card (per team or whole league) that
renders cleanly as an image: team name, grade, projected total, top 3 picks
with flags.

**Steps:**
1. New route `app/leagues/[leagueId]/draft/results/card/route.tsx` (or a
   print-friendly `?card=teamId` view) rendering a fixed-size card with
   inline styles (no external CSS) so it screenshots/exports cleanly.
2. Reuse the grade + value math from A2.
3. (Stretch) render it to PNG server-side and attach to the existing Resend
   "draft complete" notification.

---

## Part B — Standings & In-Season

### B1. Players-remaining / survivorship indicator ⭐ (World-Cup-specific killer feature)

**What:** Best-ball quietly captures your best XI, but a manager has no idea
*how much of their roster is still alive*. In a knockout tournament this is
THE thing you want to know — it's the WC analogue of "players left in a
weekly matchup."

**Goal:** On both standings and roster pages, show each team's "X / 23
players still in the tournament" (national team not yet eliminated), with a
small bar. Sortable column on standings.

**Steps:**
1. Determine each national team's elimination state from fixtures/results
   already ingested (a team is "out" once it has no remaining fixtures). Add
   a helper in `src/web/standings-view.ts`.
2. Standings: add an "Alive" column (e.g. `14/23`) with a mini progress bar;
   make it sortable.
3. Roster page: grey out / strike through players whose national team is
   eliminated; show a header count.
4. Color the bar (green > amber > red) by proportion remaining.

---

### B2. Rank movement arrows + "Manager of the Stage" ⭐

**What:** Standings show current rank but not *change*. Every app shows
"▲2 / ▼1" deltas and crowns a weekly top scorer. This is what makes people
re-check standings after each round.

**Goal:** After each scoring period, show each team's rank change vs the
prior period, and badge the single highest-scoring team of the latest stage.

**Steps:**
1. Persist a lightweight standings snapshot per period (a
   `standings_snapshot` table: leagueId, stage, fantasyTeamId, rank, total —
   written by the recompute/cron path). Cheap; one row per team per stage.
2. Standings: render ▲/▼/– next to each rank by diffing against the previous
   stage's snapshot.
3. Compute the top single-period scorer of the most recent active stage and
   show a "⭐ Manager of the Stage" badge + callout above the table.

---

### B3. Stage-by-stage trend chart

**What:** A flat table hides momentum. Other apps show a line/sparkline of
cumulative points so you can see who's surging.

**Goal:** A small multi-line chart of each team's *cumulative* best-ball
points across the nine periods, plus a per-row sparkline in the standings
table.

**Steps:**
1. We already have `entry.periods[]` per team — transform to cumulative
   series client-side.
2. Add a chart to the standings page (Chart.js or a hand-rolled inline SVG
   sparkline — keep it dependency-light and SSR-friendly).
3. Per-row mini-sparkline in a new standings column for an at-a-glance trend.

---

### B4. League ownership / "most-drafted" view

**What:** `player-shares.ts` already computes how widely each player is owned
across the league, but it's never surfaced. Ownership context is a staple of
every fantasy app ("87% rostered").

**Goal:** A small "League ownership" panel (on standings or a new
`/leagues/[leagueId]/players` tab): most-drafted players, plus each manager's
**unique picks** (players nobody else has) — a fun differentiator.

**Steps:**
1. Surface `player-shares` output through a query helper / API route.
2. Render a "Most owned" table (player, flag, % of teams, avg points) and a
   "Only you" list per manager.
3. (Stretch) on the roster page, tag each player with their league ownership %.

---

### B5. Sortable, filterable standings table

**What:** The overall table is fixed-sorted by total with static tie-breaker
columns. Users expect to click any header to sort.

**Goal:** Make the standings table client-sortable on every column (total,
final pts, goals, assists, alive count, etc.), the way the draft board
already is.

**Steps:**
1. Extract the overall table into a small client component (mirrors how the
   draft board became sortable in IMPROVEMENTS #1).
2. Clickable headers toggle asc/desc; default stays total-desc.
3. Keep rank fixed to the *total* ordering even when sorted by another column
   (show a separate "#" so re-sorting doesn't lie about standing).

---

### B6. "Points left on the table" / best-ball insight

**What:** Best-ball auto-selects your optimal XI, but managers don't see the
*value of that automation* — or how close their bench was.

**Goal:** Per team per period, show bench points (players who scored but
weren't in the best XI) so people appreciate the best-ball mechanic and see
their squad depth.

**Steps:**
1. The XI overlay already computes selected vs non-selected — extend it to
   total the non-selected scorers per period.
2. Show "best XI: 64 · bench: 18" in the overlay header.
3. (Stretch) a league-wide "deepest squad" award for most bench points.

---

## Part C — Cross-cutting QoL polish

### C1. Team identity (colors / avatars)
Let managers pick a team color or emoji on the rename form; thread it through
standings, draft board, and the results grid so columns/rows are
visually distinct. Tiny change, big perceived-quality jump.

### C2. League activity feed
A reverse-chron feed on the league home: "X drafted Y", "Recompute ran",
"Stage N scored", "Z is Manager of the Stage". Reuses the pick log + snapshot
data from B2.

### C3. Empty / loading states
Replace bare "No teams yet" / "Loading players..." with proper skeletons and
helpful empty states (esp. pre-tournament standings → point to A3).

### C4. Standings share link + auto-refresh
A copyable read-only standings link, and a gentle auto-refresh (or "new
scores available" toast off the existing recompute cron) so the table feels
live during matches.

### C5. Post-stage digest email
Reuse the Resend notifier to send a short after-each-stage recap: your rank,
rank change, Manager of the Stage, players remaining. Highest-retention
feature in most fantasy apps.

---

## Suggested build order

1. **A1 Draft Results page** — biggest visible gap, pure read of existing data.
2. **A2 Grades + value/reach** — layers onto A1, very high delight-per-effort.
3. **B1 Players-remaining** — the WC-specific signal no generic app has.
4. **B2 Rank movement + Manager of the Stage** — needs the snapshot table; do
   it before the tournament starts so snapshots accumulate from stage 1.
5. **A3 Projected standings** — fills the dead air before kickoff.
6. Then B3 / B4 / B5 / B6 and the Part C polish as time allows.

## Notes for implementation
- Run `npx tsc --noEmit` after each change — project is strict, keep it at 0.
- B2 is the only item needing a migration (the `standings_snapshot` table);
  everything else is a derived view of data already in the DB.
- Keep new charts SSR-friendly / dependency-light (inline SVG or Chart.js).
- See `IMPROVEMENTS.md` for the prior 8-item plan and its conventions.

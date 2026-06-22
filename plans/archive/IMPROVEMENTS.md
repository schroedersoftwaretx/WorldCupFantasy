# Fantasy World Cup — Improvement Plan

A prioritized list of improvements to implement. Start with any item — each
is self-contained enough to hand off as its own build prompt.

---

## 1. Surface the Projection System in the Draft Room ⭐ (highest impact)

**What:** `src/data/projection/` already contains `project-points.ts`,
`player-shares.ts`, and `recompute-projections.ts`, but none of it is
exposed in the UI.

**Goal:** In `app/leagues/[leagueId]/draft/player-board.tsx`, add a "Proj"
column to the player board showing each player's projected fantasy points
for the tournament. Make the board sortable by projected points (default)
as well as by name and position. Projected points should be precomputed and
served via the existing draft board API route
(`GET /api/leagues/[leagueId]/draft/board`) rather than computed on the
client.

**Steps:**
1. Call `recomputeProjections` (or the equivalent export from
   `src/data/projection/recompute-projections.ts`) in the board route
   handler and attach `projectedPoints` to each `DraftBoardPlayer` in the
   API response type (`src/web/api-types.ts`).
2. Add a `projectedPoints` field to `DraftBoardPlayer`.
3. In `player-board.tsx`, add a "Proj" column header and cell. Default sort
   order: descending projected points.
4. Add sort controls (click column header) for Name, Position, Proj.

---

## 2. Fix Mobile Layout

**What:** The `draft-grid` CSS uses a two-column grid (main + aside) with
no responsive breakpoints. On phones the layout breaks — the aside is
squished or overflows.

**Goal:** The draft room, standings, and roster pages must be fully usable
on a 390px-wide mobile screen.

**Steps:**
1. In `app/globals.css`, add a `@media (max-width: 700px)` breakpoint that
   collapses `.draft-grid` to a single column and stacks `.draft-side` below
   `.draft-main`.
2. Make the period breakdown table on the standings page horizontally
   scrollable on mobile (wrap in a `div` with `overflow-x: auto`).
3. Make the roster table on the roster view page similarly scrollable.
4. Ensure the draft banner, pick log, and order panel are readable at
   narrow widths (no text overflow, no horizontal scroll on the main
   column).
5. Test all pages at 390px viewport width.

---

## 3. Replace Polling with Server-Sent Events in the Draft Room

**What:** `draft-room.tsx` polls `/api/leagues/[leagueId]/draft` every 5
seconds. This is laggy and wasteful. Server-Sent Events (SSE) push state
instantly when it changes.

**Goal:** Replace the `setInterval` poll with an `EventSource` connection.
The server pushes a new draft-state payload whenever a pick is made or a
timeout is processed.

**Steps:**
1. Add a new route `GET /api/leagues/[leagueId]/draft/stream` that returns
   a `text/event-stream` response. It should emit the current draft state
   immediately on connect, then emit again whenever the state changes (poll
   the DB internally every 1–2 seconds, or use Postgres LISTEN/NOTIFY if
   available).
2. In `draft-room.tsx`, replace the `setInterval` fetch with an
   `EventSource` pointed at the new route. On each `message` event, parse
   the JSON and call `setState`.
3. Keep the board refetch logic tied to `state.picksMade` as it is now.
4. Add reconnect logic: if the `EventSource` errors, fall back to a 5-second
   poll so the draft never silently stalls.

---

## 4. Wire Email Notifications via Resend

**What:** The `Notifier` interface in `src/data/draft/notifier.ts` is
already built but the only implementation is a no-op. Adding real email
means managers get "you're on the clock" emails without having to check the
app.

**Goal:** Implement `Notifier` using [Resend](https://resend.com) (free
tier, no credit card required) and wire it into the draft tick flow.

**Steps:**
1. `npm install resend` and add `RESEND_API_KEY` to `.env.example` and
   Vercel environment variables.
2. Create `src/data/draft/resend-notifier.ts` implementing the `Notifier`
   interface. The "on clock" email should include the league name, the
   manager's team name, and a direct link to the draft room.
3. In the draft tick route (`app/api/cron/draft-tick/route.ts`), replace
   the no-op notifier with the Resend implementation when
   `process.env.RESEND_API_KEY` is set (fall back to no-op otherwise, so
   dev still works).
4. Add a "Resend not configured — email notifications disabled" warning to
   the draft room UI when the env var is absent (owner-only).

---

## 5. Show Odds in the Draft Board

**What:** `src/data/odds/odds-provider.ts` and `odds-mapping.ts` exist but
odds data is never surfaced in the UI.

**Goal:** In the draft room player board, show each player's national team
win probability (or "pts to final" implied by odds) alongside their
projected points. This gives drafters a quick sense of which players have
deep-run upside.

**Steps:**
1. Expose an odds column (e.g. "Win%" or "To Final %") in the
   `DraftBoardPlayer` API response, populated from the odds tables.
2. Add the column to `player-board.tsx` next to the Proj column.
3. If odds are unavailable (no data in DB), omit the column entirely rather
   than showing zeros.

---

## 6. Fix the Standings XI Pop-up Clipping

**What:** The `xi-popup` rendered inside a `<details>` inside a `<td>` clips
or overflows in most browsers because table cells don't establish a stacking
context. The pop-up often appears behind adjacent rows or gets cut off at
the table edge.

**Goal:** Replace the inline `<details>` pop-up with a proper tooltip/modal
that renders outside the table.

**Steps:**
1. Convert the standings page from a pure server component to a hybrid: keep
   the data-fetching logic server-side, but extract the period breakdown
   table into a client component (`standings-period-table.tsx`).
2. In the client component, track which `(teamId, stage)` cell is active via
   `useState`. On click, render the XI detail in a `position: fixed` overlay
   panel (centered or anchored near the click) rather than inline in the
   table cell.
3. Close the overlay on outside click or Escape key.
4. This also improves mobile UX — the overlay can be full-width on small
   screens.

---

## 7. Add Country Flags to the Roster Page

**What:** The roster view shows `nationalTeam` as plain text (e.g.
"France"). Replacing this with a flag emoji or flag image makes the page
much more scannable.

**Goal:** Map ISO country codes / team names to flag emoji and display them
inline in the roster table.

**Steps:**
1. Create `src/web/flags.ts`: a map from the `national_team` values stored
   in the DB to their Unicode flag emoji (e.g. `"France" → "🇫🇷"`). The
   full 32-team World Cup squad list is small enough to hardcode.
2. In `app/leagues/[leagueId]/roster/[teamId]/page.tsx`, replace the raw
   `{player.nationalTeam}` cell with `{flag(player.nationalTeam)}
   {player.nationalTeam}`.
3. Apply the same flag lookup in the draft room's pick log and roster panel.

---

## 8. Visual Polish on the Draft Room "On the Clock" State

**What:** The "you're on the clock" banner is functional but easy to miss
when you're multitasking.

**Goal:** Make it impossible to miss when it's your turn.

**Steps:**
1. When `viewer.isOnClock` is true, add a pulsing CSS animation to the
   `.draft-banner.you` class (a subtle border-color pulse or glow using
   `@keyframes`).
2. Add a `<title>` update via `useEffect` that sets the browser tab title
   to `"⏰ Your pick! — Draft Room"` when on the clock and resets it
   otherwise (`document.title`).
3. Optionally: use the [Notification API](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API)
   to send a browser push notification when the component detects the
   on-clock state changed to `true` (request permission once on draft room
   mount).

---

## Notes for implementation

- Run `npx tsc --noEmit` after each change — the project is strict and
  should stay at 0 errors.
- The sandbox test command is:
  ```
  npx tsx --tsconfig tsconfig.json src/data/<path>.ts
  ```
- Integration tests use embedded Postgres via `src/test/db.ts` and run with
  `npm test`.
- Vercel environment variables needed: `RESEND_API_KEY` (item 4),
  `ODDS_API_KEY` (item 5 — check existing `.env.example`).

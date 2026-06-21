# Mobile-Friendly Frontend Plan

**Goal:** Make the World Cup Fantasy web app genuinely usable on phones, building on the partial mobile work already in `app/globals.css`.

**Stack context:** Next.js 15 App Router · React 19 · plain hand-written CSS in a single `app/globals.css` (~1750 lines, UTF-8 + CRLF). No Tailwind despite old comments suggesting it.

---

## Audit: current state

**Already done (good foundation):**
- One `@media (max-width: 720px)` breakpoint (3 blocks) collapsing `.draft-grid` and `.value-grid` to single column and tightening gutters.
- `@media (pointer: coarse)` block enforcing 44px minimum tap targets.
- `prefers-reduced-motion` handling.
- `.table-scroll` (`overflow-x: auto`) wrappers on most stats tables.

**Gaps found in the code:**
1. **No `viewport` meta tag** in `app/layout.tsx`. This is the single biggest issue — mobile browsers render at ~980px desktop width and shrink, so the existing 720px media queries effectively never fire on real phones.
2. **`.league-tabs` / `.league-tab` nav has no CSS at all** — renders as unstyled inline links with no mobile scroll/wrap handling.
3. **Header doesn't reflow** — `.site-header` is `display:flex; justify-content:space-between` holding title + nav + notification bell + display name + sign-out. On narrow screens only padding shrinks; the content crams.
4. **6 tables not wrapped in `.table-scroll`** and will overflow horizontally on phones:
   - `app/leagues/[leagueId]/draft/player-board.tsx` (the large interactive draft list — highest impact)
   - `app/leagues/[leagueId]/page.tsx` (main league page table)
   - `app/leagues/[leagueId]/draft/scoring-rules.tsx`
   - `app/account/notifications/notification-settings.tsx`
   - one table in `app/leagues/[leagueId]/standings/standings-period-table.tsx`
   - one table in `app/leagues/[leagueId]/draft/results/page.tsx`
5. **Only one breakpoint (720px)** — nothing tuned for small phones (≤380px) or tablets (~768–1024px).

---

## Plan (prioritized)

### P0 — Critical, do first (low risk, huge payoff)

**1. Add the viewport meta tag.**
In `app/layout.tsx`, add a Next 15 viewport export:
```ts
import type { Viewport } from "next";
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // optional: viewportFit: "cover" for notched-phone safe areas
};
```
This alone makes the existing media queries actually work on phones. Verify with `npm run typecheck`.

**2. Wrap the 6 unwrapped tables in `.table-scroll`.**
Wrap each `<table>` listed above in `<div className="table-scroll">…</div>`. The class already exists; this is purely additive and prevents horizontal page overflow. Player-board first (most-used screen during a live draft).

### P1 — Core navigation & layout reflow

**3. Style `.league-tabs` for mobile.**
Give the tab bar real CSS: horizontal layout with `overflow-x: auto`, `flex-wrap` fallback, `-webkit-overflow-scrolling: touch`, hidden scrollbar, and ≥44px tap height per tab. This is the primary in-league navigation and currently unstyled.

**4. Reflow the site header at ≤720px.**
Let the header wrap or stack: allow `.site-header` to `flex-wrap`, shrink `.site-title`, and keep the notification bell + user chip on one row. Ensure the bell and sign-out remain ≥44px tap targets (the `pointer: coarse` block should already help, but verify).

### P2 — Full per-page tuning pass

**5. Draft room (`draft-room.tsx`, `player-board.tsx`, `queue-panel.tsx`).**
The most layout-dense screen. Confirm the grid collapses cleanly, the player board scrolls, the queue panel stacks below (not beside) on mobile, and action buttons (`.board-actions`) stack — already handled at line ~1690, verify.

**6. Standings & stats tables.**
With scroll wrappers in place, also reduce table font/padding at ≤720px for density, and consider sticky first column (team/player name) on the widest tables (draft-board, standings) so the label stays visible while scrolling.

**7. Roster pitch (`roster-pitch.tsx` / `best-lineup.tsx`).**
Confirm the SVG uses a `viewBox` (scales) rather than fixed pixel width. Add `max-width: 100%; height: auto` if not already. Make the week selector tappable.

**8. Modals (`xi-overlay`, `player-stats-modal`).**
Already `max-width: 420px` with padding — verify they fit within small viewports (≤360px) and that `max-height: 85vh` + internal scroll works; add safe-area padding if needed.

### P3 — Polish & breakpoints

**9. Add a second breakpoint** for small phones (≤380px): smaller base font, tighter chip/badge spacing.
**10. Optional tablet tuning** (~768–1024px) so two-column grids don't collapse prematurely.
**11. Forms & inputs** — ensure inputs are `font-size: 16px+` on mobile to stop iOS auto-zoom on focus; full-width buttons on narrow screens.

---

## Verification

- `npm run typecheck` after the layout.tsx change.
- `npm run build` to confirm no regressions.
- Manual check at 360px, 390px, 768px widths (browser devtools device toolbar) for: home, league overview, draft room, standings, a stats table page, roster page.
- No horizontal page scroll on any page at 390px (table scroll is fine; *page* scroll is not).

---

## Suggested execution order / branches

Per your usual workflow, commit each phase as you go (avoid losing uncommitted work):
- **Branch `mobile-p0`**: viewport tag + table-scroll wraps → verify → merge. (Biggest win, smallest diff.)
- **Branch `mobile-p1`**: tab nav + header reflow.
- **Branch `mobile-p2`**: per-page tuning.
- **Branch `mobile-p3`**: breakpoints + form polish.

P0 + P1 deliver ~80% of the perceived improvement.

# World Cup Fantasy Draft — Project Plan

> A draft-based fantasy game for the 2026 FIFA World Cup. Managers draft a permanent
> 23-player squad before the tournament; rosters are final; scoring is cumulative
> total points; elimination risk is the core skill.

---

## 1. Product summary

A web application where a private group of users (a **league**) runs a snake draft to
build permanent fantasy squads from any player in the 48 World Cup squads. Rosters are
**final** — there are no transfers, waivers, or replacements. As real players score
goals, assists, clean sheets, etc., their fantasy points accumulate. Because a knocked-out
nation's players score zero for the rest of the tournament, the central strategic skill is
drafting players who will both perform *and* advance, while absorbing injury and
squad-omission risk.

**Default game mode (MVP): best ball.** Each scoring period, the system retroactively
computes the optimal legal starting XI from the players who actually played, so there is
no lineup deadline to manage. Manual start/sit (with per-fixture locks) is a post-MVP
mode that reuses the same scoring engine.

---

## 2. The tournament (hard external facts)

- **Dates:** June 11 – July 19, 2026. Group stage June 11–27; Round of 32 begins June 28.
- **Format:** 48 teams, 12 groups of 4. Top 2 per group + 8 best third-placed teams → 32.
- **Stages (used as scoring periods):**
  `GROUP_1`, `GROUP_2`, `GROUP_3`, `R32`, `R16`, `QF`, `SF`, `THIRD_PLACE`, `FINAL`.
- **Matches within a knockout round are spread across several days** — this is why
  lineup locks (post-MVP) must be **per-fixture kickoff**, not per-round.
- **Squad lock:** final 48-team squads (~23 players each, ~1,100+ players total) are
  confirmed around May 24–25. **Drafts deliberately do not wait for this** — drafting a
  player who is later cut is an accepted dead pick and part of the skill.
- **Penalty shootout goals are not official goals** and do not score. Extra-time stats
  count normally.

---

## 3. Locked design decisions

| Area | Decision |
|---|---|
| Roster permanence | Final. No transfers, waivers, or replacements. |
| Scoring model | Cumulative total points. Standings = sum, descending. |
| League size | 2–24 managers. |
| Roster size | 23 players = 23 snake-draft rounds. |
| MVP game mode | Best ball (optimal legal XI computed retroactively). |
| Post-MVP mode | Manual start/sit with per-fixture kickoff locks. |
| Draft type | Snake. Each real player draftable exactly once per league. |
| Draft cadence | Asynchronous, 12-hour per-pick timer. |
| Autopick | Constraint-aware (see §6). |
| Notifications | Email (MVP). |
| Auth | Firebase JWT. |
| Data source | API-Football (api-sports.io), `league=1`, `season=2026`, behind an internal abstraction. |
| Stack | Next.js (frontend), Postgres (datastore), separate stats-ingestion worker. |

---

## 4. Roster construction

### 4.1 Starting XI (11 players)

- Exactly **1 GK**
- **4–5 DEF**
- **2–4 MID**
- **2–3 FWD**
- **Flex 1:** MID or DEF
- **Flex 2:** MID or FWD

All combinations must total 11. (Effective ranges: 4–5 DEF, 2–4 MID, 2–3 FWD, 1 GK.)

### 4.2 Full 23-man roster (derived, provably lineup-legal)

| Position | Min | Max | Rationale |
|---|---|---|---|
| GK | 2 | 4 | One starts; a second is mandatory so an eliminated keeper can't permanently brick the lineup. |
| DEF | 6 | 8 | Most XI-demanding position (4–5), so most elimination-exposed; 6 guarantees bench depth. |
| MID | 5 | 8 | Covers both flex slots leaning midfield plus a backup. |
| FWD | 4 | 8 | Covers up to 3 starters plus a spare. |

**Legality proof sketch:** minimums sum to 17, leaving **6 discretionary picks** (within
maxes) to reach 23. Remaining capacity above the minimums is GK +2, DEF +2, MID +3, FWD
+4 = 11 ≥ 6, so every legal draft can always complete. The minimum config (2/6/5/4)
still fields a legal XI with a 12-player bench. Inability to field a full legal XI deep
in the knockouts due to eliminations is **intended game behavior**, not a rules defect.

### 4.3 Per-league draft caps (per manager)

- Max **4** GK
- Max **8** DEF / MID / FWD each

These caps equal the roster maximums above, so the validator is a single shared rule set.

---

## 5. Scoring ruleset

Scoring is a **pure, recomputable function** of immutable raw stat records. Points are
never stored as the source of truth — they are always derivable so corrections can be
replayed.

### 5.1 Point values

| Event | Points |
|---|---|
| Appearance (played any minutes) | +1 |
| Played 60+ minutes (additional) | +1 |
| Goal — GK | +10 |
| Goal — DEF | +6 |
| Goal — MID | +5 |
| Goal — FWD | +4 |
| Assist (any position) | +4 |
| Save (each) | +1 |
| Clean sheet — GK / DEF | +5 |
| Penalty saved (GK) | +2 |
| Penalty missed | −2 |
| Own goal | −2 |
| Yellow card | −1 |
| Red card | −5 |

### 5.2 Edge-case rulings (must be implemented exactly)

- **Clean sheet:** awarded only if the player was on the pitch for **60+ minutes** *and*
  the team conceded **0 goals in regulation + extra time**. A defender subbed off at 55'
  with the score level does **not** earn it.
- **Penalty shootout goals do not score.** They are not official goals.
- **Extra-time stats count** normally toward all events.
- Card points are per card type, not cumulative escalating.
- A red card ends the player's appearance for clean-sheet timing purposes from the
  minute of dismissal.

### 5.3 Tie-breaker ladder (final standings)

Apply in order until resolved:

1. Total points (primary).
2. Total points scored by the manager's rostered players **in the Final match**.
3. Total tournament **goals** by the manager's rostered players.
4. Total tournament **assists** by the manager's rostered players.
5. **Shared placement** (managers share the rank).

---

## 6. Architecture

### 6.1 Components

- **Frontend** — Next.js (App Router). Server components for league/standings/roster
  pages. The draft is asynchronous, so real-time websockets are a nice-to-have, not the
  backbone.
- **App/API service** — leagues, rosters, draft state machine, roster-legality
  validation, standings.
- **Stats-ingestion worker** — separate process. Polls the data provider on a schedule:
  sparse between matchdays, ~15–30s during live matches. Writes immutable `StatLine`
  records and triggers idempotent score recomputation. Kept separate so live-match
  polling never contends with user requests.
- **Datastore** — Postgres (strong consistency for drafts and scoring).
- **Auth** — Firebase JWT.
- **Provider abstraction** — the scoring engine and app never call the vendor directly.
  All provider access goes through an internal `StatsProvider` interface so the vendor
  can be swapped and so the feed can be mocked for testing (live matches can't be
  replayed).

### 6.2 Core data model

| Entity | Purpose |
|---|---|
| `Player` | FIFA player: position, national team, source player ID, status. |
| `NationalTeam` | Group, tournament status, elimination stage. |
| `Fixture` | Match: stage, kickoff UTC, status, source fixture ID. |
| `League` | Private group; embeds a `ScoringRuleset` (JSON config). |
| `DraftRoom` | Belongs to a league; snake order, current pick, 12h timer state. |
| `FantasyTeam` | A manager's permanent 23-player roster within a league. |
| `RosterSlot` | Player ↔ FantasyTeam membership with drafted position. |
| `Lineup` | (Post-MVP) manager-set XI per stage with per-fixture locks. |
| `StatLine` | **Immutable** raw per-player, per-fixture stats from the provider. |
| `ScoreEntry` | **Derived**, disposable: `score(StatLine, ScoringRuleset)`. |

`StatLine` is the source of truth and is never mutated by app logic (only re-ingested
from the provider). `ScoreEntry` is always recomputable and may be wiped and rebuilt.

### 6.3 The async draft (load-bearing constraints)

Up to 24 managers × 23 rounds = **552 picks** with a 12-hour timer. This is **not a
live draft room** — it is a notification-driven asynchronous draft (closer to an email
draft). A typical well-behaved draft spans 5–10 real days.

- Core loop: notify on-the-clock manager → accept their pick whenever it arrives →
  advance → **autopick at 12h expiry**.
- **Email notifications are load-bearing** — the whole UX depends on reliably telling a
  manager it is their turn.
- **Constraint-aware autopick** must select the best available player that (a) violates
  no draft cap and (b) does not make a legal 23-man roster impossible given the
  manager's remaining picks. This is a real algorithm, not a one-liner, and it runs
  constantly (overnight, work hours).

---

## 7. Phased build plan

| Phase | Deliverable | On MVP critical path? |
|---|---|---|
| **1. Data spine** | Provider integration behind `StatsProvider`; schema; ingest 48 squads + 104-match schedule; prove end-to-end per-player stats for a finished match. | Yes |
| **2. Scoring engine** | Pure, recomputable scoring function + ruleset config; validated against a past tournament's match data. | Yes |
| **3. Leagues & rosters** | Create league, configure scoring, invite managers, position min/max validator. | Yes |
| **4. Async draft + autopick** | Snake order, 12h timer, email notifications, constraint-aware legality-preserving autopick. | Yes |
| **5. Best-ball scoring & standings** | Lineup optimizer (optimal legal XI), total-points standings, tie-breaker ladder, live updates. | Yes |
| **6. Post-MVP** | Manual start/sit mode with per-fixture locks; live draft room; richer notifications. | No |

The two genuinely hard algorithms are the **constraint-aware autopick** (Phase 4) and
the **best-ball lineup optimizer** (Phase 5); both deserve a dedicated design pass
before implementation.

---

## 8. Timeline reality (as of mid-May 2026)

To play *this* World Cup, a league must finish a ~5–10-day async draft before the
**June 11** kickoff, so the platform must be live and tested by early June and a draft
started by then. Phases 1–5 solo in ~2–3 weeks is extremely aggressive. Realistic paths:

- **A — Private beta:** ship a minimal version for one personal league with a much
  shorter timer this cycle; treat the full build as targeting future tournaments.
- **B — Shortened timer:** for this run only, drastically shorten the per-pick timer
  (e.g., 1–2 hours) so 552 picks complete in the window.
- **C — Build for the future:** don't force a 2026 launch; the architecture is
  identical regardless of which tournament it first runs on.

---

## 9. Open items (architecture-neutral)

None block implementation. Scoring values in §5.1 are finalized; refine only after
inspecting live provider data if any event proves unavailable or differently shaped for
World Cup fixtures.

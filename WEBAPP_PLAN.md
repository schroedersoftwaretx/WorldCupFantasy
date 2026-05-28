# World Cup Fantasy — Web Application Build Plan

> Companion to `WORLDCUP_FANTASY_PLAN.md`. That document covered the
> backend and is fully built. This document covers turning that backend
> into a web application a small private group — initially two friends —
> can use from a browser to run a draft and follow standings.

---

## 1. Where things stand

The backend is complete and tested: five phases, 143 passing tests, four
database migrations.

- **Data spine** — Postgres schema, a `StatsProvider` abstraction over
  API-Football, idempotent ingestion of squads / schedule / match stats.
- **Scoring engine** — a pure, recomputable points function.
- **Leagues & rosters** — managers, leagues, token invites, and the
  roster validator (the 23-man legality + completability rules).
- **Async draft** — snake order, a 12-hour pick timer, and the
  constraint-aware autopick.
- **Best-ball & standings** — the lineup optimizer and the cumulative
  standings with the tie-breaker ladder.

Everything is reachable today through one command-line tool. What does
**not** exist is everything a non-technical person touches: there is no
web server, no user interface, no login, and nothing deployed.

The single most important fact for this plan: the backend was built
**framework-agnostic**. The whole `src/data/` layer is plain TypeScript
with no web or CLI assumptions baked in. The web app **imports** that
layer as a library — it does not reimplement game logic. That is what
keeps this plan about wiring and screens rather than rebuilding the hard
parts.

## 2. What "done" means

A deployed URL where:

- you and a friend each sign in,
- one of you creates a league and sends the other an invite link,
- you run a draft together in the browser — see whose turn it is, browse
  the available players, make picks, watch your roster fill up,
- and once real matches are played, the league shows live standings.

Scope is deliberately the **two-friends minimum**. Every choice below is
made so the app can later grow into the full 2–24-manager product the
original plan describes, but no effort is spent now on polish or scale
that two people do not need.

## 3. Locked design decisions

| Area | Decision |
|---|---|
| Scope | Slim "two friends" private league. Architecture stays growable to 24 managers. |
| Framework | Next.js (App Router), in the same repository, importing `src/data/`. |
| Auth | Firebase Authentication (Google sign-in). Manager identity keyed by Firebase UID — the `manager.firebase_uid` column already exists for exactly this. |
| Real-time | Polling / refresh, not websockets. A 2-person draft does not need a live socket; the original plan already calls websockets a nice-to-have. |
| Draft timer | The existing `processExpiredPicks` runs on a schedule via Vercel Cron. For a 2-person draft, also a manual "process timeouts" button. |
| Notifications | In-app "you're on the clock" indicator for the MVP. Real email is optional and deferred — the `Notifier` seam is already built for it. |
| Hosting | Next.js on Vercel; Postgres on a managed host (Neon or Supabase). |
| Styling | Minimal and functional (Tailwind CSS). No design system, no theming. |
| Timeline | No hard deadline. The architecture runs on whichever tournament is next. |
| CLI | Kept. It remains the operational tool for data ingestion and admin tasks, sharing the same `src/data/` library. |

Anything in this table is a proposal open to revision — flag it before
the relevant phase starts.

## 4. Architecture

```
  Browser
    |
    |  (HTTPS, Firebase ID token)
    v
  Next.js app  (App Router, on Vercel)
    |   Server Components  -> render leagues / standings / roster pages
    |   Server Actions / Route Handlers -> calls into the backend
    |   Client Components  -> the interactive draft room, polling for state
    |
    |  (in-process function calls — no separate API service)
    v
  src/data/   (the existing, unchanged backend library)
    |
    v
  Postgres  (managed: Neon / Supabase)

  Vercel Cron --> a route that runs processExpiredPicks  (the draft tick)
  CLI         --> the same src/data/ library, for ingestion + admin
```

Key points:

- **No separate API service.** At two-friends scale the Next.js server
  calls `src/data/` functions directly, in the same process. The backend
  was built to allow this. A standalone API service is a later-scale
  concern, not an MVP one.
- **The data layer is untouched.** `src/data/` is consumed as a library
  by both the web app and the CLI. Game logic is not duplicated.
- **Auth flow.** Firebase issues an ID token to the browser on sign-in.
  Every server action verifies that token with the Firebase Admin SDK and
  resolves it to a `manager` row (find-or-create by `firebase_uid`).
- **The draft timer** is the existing `processExpiredPicks`, triggered by
  a scheduled Vercel Cron request — plus a manual button, since a
  2-person draft is often done in one sitting.

## 5. Phased build plan

| Phase | Deliverable |
|---|---|
| **W1. Next.js shell + API boundary** | A Next.js app in the repo that imports `src/data/`. Server actions / route handlers exposing the league, roster, draft, and standings operations, with defined request/response shapes. A health route plus one real read view (e.g. a league's standings) to prove the wiring end to end. |
| **W2. Authentication** | A Firebase project; a Google sign-in page; server-side ID-token verification that resolves to a `manager` row; every server action auth-gated. After this, the app knows who you are. |
| **W3. Leagues UI** | The first screens a signed-in user sees: a dashboard of your leagues, a create-league form, and the invite flow — the owner generates a link, the friend opens it and joins. Two people can now reach the same league entirely through the browser. |
| **W4. The draft room** | The centerpiece. The draft-room page: the snake order and whose pick it is, a searchable / filterable board of available players, a turn-checked and roster-validated "draft this player" action, your roster filling up with live position counts, and the pick deadline. State refreshes by polling. The tick is wired to Vercel Cron plus a manual trigger. Outcome: a full draft, browser to browser. |
| **W5. Standings & in-season** | The standings page (cumulative totals, the best-ball XI per scoring period, the tie-breaker ladder), the roster view during the season, and the in-tournament data-refresh story — ingest match stats and recompute scores on a schedule. |
| **W6. Deploy & operate** | A managed Postgres; the Next.js app deployed to Vercel; environment variables wired; the scheduled jobs running; and the one-time real-data load (ingest the actual squads and schedule). Outcome: a URL your friend can open. |

**On ordering:** deployment (W6) can be pulled forward. Standing up
hosting right after W1 or W2 lets your friend follow along in a real
browser as the app is built; W6 then becomes "production hardening,
scheduled jobs, and the real data load." Either way works.

**On difficulty:** W4 (the draft room) is the only phase that is heavy on
genuinely new interactive-UI work. W1–W3 and W5 are mostly forms, lists,
and tables placed over backend calls that already exist and are tested.
W2 (Firebase) is small but fiddly — see the risks below.

Each phase, like the backend phases, can be handed off as its own
self-contained build prompt.

## 6. The two-friends simplifications

What is deliberately cut or shrunk for the MVP, and why each is safe:

- **No websockets.** Polling the draft state every few seconds is
  perfectly adequate for two people. Upgrade path: add a websocket or
  server-sent-events channel when leagues get large.
- **Email is optional.** The in-app "you're on the clock" indicator,
  plus simply texting your friend, covers a 2-person draft. The durable
  notification queue and `Notifier` interface are already built, so real
  email is a drop-in later.
- **The timer can be short or manual.** A 2-person draft is about 46
  picks and can be done in a single sitting with a short timer, or even
  by pressing the manual "process timeouts" button.
- **No admin UI.** Data ingestion and score recomputation stay on the
  CLI and cron. An admin screen is a full-product concern.
- **Minimal styling.** Functional layout over visual design.

Every one of these has a clear, already-seamed upgrade path to the full
product — none of them is a dead end.

## 7. Risks and open items

- **Firebase is the fiddliest piece.** Wiring the client SDK, the Admin
  SDK service-account credentials, and server-side token verification
  correctly takes care. Budget extra attention in W2.
- **Real player data depends on the provider.** Live squads come from
  api-sports.io and are only fully populated around the official
  squad-lock. The ingestion is built and idempotent; this is a timing
  note, not a code risk.
- **Vercel + Postgres connection handling.** Vercel's serverless model
  needs a connection-pooled or serverless-friendly Postgres driver (e.g.
  Neon's serverless driver, or a pooler in front of Supabase). Decide
  this in W6; it may mean a small change to the DB client.
- **Vercel Cron granularity.** Scheduled jobs have a minimum interval.
  Fine for a 12-hour draft timer and for periodic stats ingestion —
  just a known constraint.

None of these block starting W1.

## 8. Suggested first step

Begin with **W1**. It is self-contained, low-risk wiring on top of a
backend that is already built and tested, and it produces something
visible — the backend reachable in a browser — quickly. From there the
phases proceed in order, W6 (or an early partial deploy) whenever a
shareable URL becomes useful.

# Deployment guide (W6)

This document walks through getting the app live on Vercel with a Neon
Postgres database. Follow the steps in order; each section ends with a
verification step so you know it worked before moving on.

---

## Prerequisites

- The repo is pushed to a GitHub (or GitLab / Bitbucket) repository.
- You have a [Vercel account](https://vercel.com) (free tier is fine).
- You have a [Neon account](https://neon.tech) (free tier is fine).
- You have completed `FIREBASE_SETUP.md` — you need the Firebase values in
  the env-var table below.
- You have an [API-Football key](https://dashboard.api-football.com) for the
  live data ingest (the `API_FOOTBALL_KEY` value).

---

## Step 1 — Create the Neon database

1. Sign in to [console.neon.tech](https://console.neon.tech).
2. Click **New project**. Accept all defaults (region closest to you is fine).
3. Neon creates a project and a default database called `neondb`.
4. On the project dashboard, find the **Connection details** panel.
   You need **two** connection strings — copy both somewhere safe:

   | Name | Where to find it | Looks like |
   |---|---|---|
   | **Direct URL** | "Connection string" (default view) | `postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require` |
   | **Pooler URL** | Switch the "Connection type" dropdown to **"Pooled connection"** | `postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require` |

   The pooler hostname contains `-pooler.` — that is the only difference.

5. **Verify**: both strings start with `postgresql://` and end with
   `?sslmode=require`. Keep them handy for Steps 2 and 3.

---

## Step 2 — Run the database migrations

Run this on your local machine — it creates all the tables in Neon.

```bash
# Add both URLs to .env temporarily (or export them directly)
DIRECT_DATABASE_URL="postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"

# Apply every pending migration against the direct URL
DIRECT_DATABASE_URL="$DIRECT_DATABASE_URL" npm run migrate
```

Expected output: `migrations applied`

If you see `migrations applied` the schema is in Neon and the tables exist.

> **Why the direct URL here?** Neon's pooler runs in transaction mode, which
> is incompatible with Drizzle's migration runner. The migrator automatically
> prefers `DIRECT_DATABASE_URL` over `DATABASE_URL` for exactly this reason.

---

## Step 3 — Create the Vercel project

1. Go to [vercel.com/new](https://vercel.com/new).
2. Click **Import Git Repository** and select your repo.
3. Vercel auto-detects Next.js — accept all framework defaults.
4. **Before** clicking Deploy, click **Environment Variables** and add every
   variable from the table below.

### Environment variables

Add all of these in the Vercel dashboard under
**Project → Settings → Environment Variables**.
Set each one for **Production**, **Preview**, and **Development** unless noted.

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | Neon **pooler** URL | Used by the web app at runtime. Must be the pooler URL, not the direct URL. |
| `DIRECT_DATABASE_URL` | Neon **direct** URL | Used only by `npm run migrate`. Can be set here for convenience even though you will typically run migrations locally. |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | From Firebase console | Safe to expose — has `NEXT_PUBLIC_` prefix. |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | From Firebase console | e.g. `your-project.firebaseapp.com` |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | From Firebase console | |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | From Firebase console | |
| `FIREBASE_PROJECT_ID` | From Firebase service-account JSON | Server-only. Same value as `NEXT_PUBLIC_FIREBASE_PROJECT_ID`. |
| `FIREBASE_CLIENT_EMAIL` | From Firebase service-account JSON | e.g. `firebase-adminsdk-xxx@your-project.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | From Firebase service-account JSON | **Include the full key with literal `\n` sequences**, wrapped in double quotes: `"-----BEGIN PRIVATE KEY-----\nMIIE...\n-----END PRIVATE KEY-----\n"` |
| `API_FOOTBALL_KEY` | Your api-football.com key | Required for the automated ingest-and-score cron AND the CLI. Get it from [dashboard.api-football.com](https://dashboard.api-football.com). |
| `CRON_SECRET` | A random secret | Generate with `openssl rand -hex 32`. Vercel sends this automatically on cron calls. |

> **FIREBASE_PRIVATE_KEY pitfall:** Vercel stores env vars as plain strings.
> Paste the private key value exactly as it appears in the downloaded JSON
> file — it will have literal `\n` escape sequences, not real newlines.
> If sign-in fails with a Firebase Admin error, this is the first thing
> to check.

4. Click **Deploy**. The first build takes about a minute.
5. **Verify**: open `https://your-app.vercel.app/api/health`. You should see:
   ```json
   { "ok": true, "data": { "status": "ok", "db": "up", "firebaseAdmin": "configured", ... } }
   ```
   If `db` is `"down"` — recheck `DATABASE_URL`. If `firebaseAdmin` is
   `"unconfigured"` — recheck the three `FIREBASE_*` server-side vars.

---

## Step 4 — Add your Vercel domain to Firebase

Firebase rejects sign-in from domains it doesn't recognise.

1. Go to the [Firebase console](https://console.firebase.google.com) →
   your project → **Authentication → Settings → Authorized domains**.
2. Click **Add domain** and add your Vercel URL:
   `your-app.vercel.app`
3. If you have a custom domain, add that too.

**Verify**: open `https://your-app.vercel.app/login` and sign in with Google.
You should land on the dashboard (`/`).

---

## Step 5 — Load the real World Cup data

The database is empty after migration — no players, no fixtures. Load them
from your local machine using the CLI, pointed at the Neon **direct** URL
(the ingestion commands run long transactions; use the direct URL, not the
pooler).

```bash
# Point the CLI at Neon for this session
export DATABASE_URL="postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"
export API_FOOTBALL_KEY="your-key-here"
export WORLDCUP_LEAGUE_ID=1
export WORLDCUP_SEASON=2026

# 1. Ingest all national team squads (~736 players across 32 teams)
#    Takes a few minutes — the provider is rate-limited to ~10 req/min.
npm run cli -- ingest:squads

# 2. Ingest the match schedule (104 fixtures)
npm run cli -- ingest:schedule

# 3. (After matches are played) Ingest stats for a specific fixture
#    Replace SOURCE_FIXTURE_ID with the provider's fixture id.
npm run cli -- ingest:fixture-stats --fixture SOURCE_FIXTURE_ID

# 4. Recompute fantasy scores for all stat_lines
npm run cli -- score:recompute
```

> **Timing note**: squad data is only fully populated after the official
> FIFA squad submission deadline (typically a few weeks before the
> tournament). Before that, squads may be incomplete or provisional. The
> ingest is idempotent — re-running it is safe and picks up any updates.

**Verify**: open `https://your-app.vercel.app`. Sign in, create a league,
invite your friend via the invite link. You should both see the league and
be able to enter the draft room.

---

## Step 6 — Verify the scheduled jobs

Two cron jobs are configured in `vercel.json`:

| Job | Schedule | Route | Purpose |
|---|---|---|---|
| Draft tick | Every 6 hours | `/api/cron/draft-tick` | Autopicks lapsed draft picks |
| Score recompute | Every 30 minutes | `/api/cron/ingest-scores` | Recomputes fantasy scores from latest stat_lines |

Check they are registered:

1. Vercel dashboard → your project → **Settings → Cron Jobs**.
2. Both jobs should appear with their schedules.
3. Click **Run** on each to trigger them manually; the response should be
   `{ "ok": true, ... }`.

> **Cron granularity note**: Vercel's Hobby plan allows cron jobs no more
> frequent than once per day. The Pro plan allows up to once per minute.
> The 30-minute `ingest-scores` schedule requires at minimum the Pro plan.
> On Hobby, change it to `"0 */2 * * *"` (every 2 hours) — or trigger
> recompute manually from the standings page owner button after each CLI
> ingest run.

---

## Step 7 — In-season operations

Once the tournament starts the operational loop depends on how you have set up the cron:

**Fully automated (API_FOOTBALL_KEY set in Vercel):**
The `ingest-and-score` cron runs every 30 minutes and handles everything.
No manual steps needed after initial squad and schedule ingestion.

**Manual / Hobby plan fallback:**
Run these CLI commands against the production database after each matchday:
```bash
export DATABASE_URL="postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require"
export API_FOOTBALL_KEY="your-key-here"

# Option A -- ingest everything that finished since the last run (recommended)
npm run cli -- ingest:all-finished

# Option B -- ingest one specific fixture by its API-Football id
# Run `fixtures:list` first to find the right sourceFixtureId:
npm run cli -- fixtures:list
npm run cli -- ingest:fixture-stats SOURCE_FIXTURE_ID
npm run cli -- score:recompute
```

2. Fantasy scores update automatically in the web app as soon as
   `score_entry` rows are written — `computeStandings` runs live on every
   standings page load.

3. The standings page owner button ("Recompute scores") also triggers
   recomputation on demand, without CLI access.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `"db": "down"` at `/api/health` | `DATABASE_URL` wrong or missing | Recheck the Vercel env var — must be the **pooler** URL with `?sslmode=require` |
| `"firebaseAdmin": "unconfigured"` at `/api/health` | Missing Firebase server vars | Recheck `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` |
| Sign-in fails with Firebase error | Domain not authorised | Add `your-app.vercel.app` to Firebase Auth → Authorized domains |
| `FIREBASE_PRIVATE_KEY` error in Vercel logs | Newlines not preserved | Paste the key with literal `\n` sequences; Vercel should store and expand them |
| Migration fails: "prepared statement" error | Using pooler URL for migrations | Use `DIRECT_DATABASE_URL` (non-pooler hostname) when running `npm run migrate` |
| Cron jobs not running | Hobby plan frequency limit | Upgrade to Vercel Pro, or lengthen the schedule in `vercel.json` |
| Players not appearing in draft board | Squads not ingested | Run `npm run cli -- ingest:squads` against the production database |

---

## Custom domain (optional)

1. Vercel dashboard → your project → **Settings → Domains** → Add.
2. Point your domain's DNS to Vercel as instructed.
3. Add the custom domain to Firebase Auth → Authorized domains.
4. Update `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` if it is a custom domain
   (usually not needed — Firebase auth domain stays as
   `your-project.firebaseapp.com`).

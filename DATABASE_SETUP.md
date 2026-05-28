# Database setup

The app stores everything — leagues, rosters, drafts, scores — in a
PostgreSQL database. It will not run until `DATABASE_URL` in your `.env`
points to a real, reachable Postgres database.

If `http://localhost:3000/api/health` shows `"database unreachable"`, this is
the thing to fix. (Right now `DATABASE_URL` is still the placeholder value
that ships in `.env.example`, which points at a database on your own machine
that does not exist.)

You have two options. The hosted one — **Neon** — is recommended: it is free,
takes about two minutes, needs nothing installed, and is the same kind of
database the app will use once it is deployed (phase W6), so it is not
throwaway work.

---

## Option A — Neon (recommended: free, hosted, no install)

1. Go to <https://neon.tech> and sign up. The free tier is plenty; you can
   sign in with a Google account.
2. Create a project. Accept the defaults — Neon automatically creates a
   database inside it.
3. On the project dashboard, find the **connection string** (there is a copy
   button next to it). It looks like this:

   ```
   postgresql://alex:AbC123xyz@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

4. Open `.env` in the project folder and set `DATABASE_URL` to that string —
   the whole thing, including the `?sslmode=require` on the end:

   ```
   DATABASE_URL=postgresql://alex:AbC123xyz@ep-cool-name-12345.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

5. Create all the tables by applying the migrations:

   ```bash
   npm run migrate
   ```

   You should see `migrations applied`.

6. Restart the dev server: stop it with `Ctrl+C`, then `npm run dev` again.

7. Open <http://localhost:3000/api/health>. It should now report
   `"db":"up"`, and sign-in will work.

## Option B — a local PostgreSQL

If you would rather run Postgres on your own machine:

1. Install PostgreSQL — on Windows, the installer from
   <https://www.postgresql.org/download/windows/>. During setup you choose a
   password for the `postgres` user; remember it.
2. Create a database for the app — using the bundled pgAdmin tool, or on the
   command line:

   ```bash
   createdb worldcup_fantasy
   ```

3. Set `DATABASE_URL` in `.env` to point at it (use the password from step 1):

   ```
   DATABASE_URL=postgres://postgres:YOUR_PASSWORD@localhost:5432/worldcup_fantasy
   ```

4. Run `npm run migrate`, then restart `npm run dev` — steps 5 to 7 above.

---

## Notes

- **`npm run migrate`** loads `.env` automatically and applies every pending
  migration. It is safe to run more than once — already-applied migrations
  are skipped.
- **The database starts empty.** After migrating you have all the tables but
  no players or fixtures yet. You can still sign in, create a league, and
  invite a friend. Loading the real World Cup squads and schedule is a
  separate ingestion step (the CLI's `ingest:*` commands, wired up in phase
  W6).
- **Still "database unreachable"?** Re-check the connection string for typos,
  make sure you restarted the dev server after editing `.env`, and — for a
  hosted database like Neon — keep the `?sslmode=require` suffix.

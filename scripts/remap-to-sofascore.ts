/**
 * Remap provider IDs from football-data to SofaScore, in place.
 *
 *   DRY RUN (default, writes nothing):
 *     node --env-file=.env --import tsx scripts/remap-to-sofascore.ts
 *
 *   APPLY (rewrites source_*_id columns in one transaction):
 *     node --env-file=.env --import tsx scripts/remap-to-sofascore.ts --apply
 *
 * Strategy: internal serial ids (national_team.id, player.id, fixture.id) stay
 * frozen, so every roster_slot / draft_pick / stat_line / score_entry reference
 * survives untouched. Only the provider-specific columns are rewritten:
 *   national_team.source_team_id, player.source_player_id, fixture.source_fixture_id
 *
 * Apply is REFUSED unless every player on a drafted roster is matched. Resolve
 * leftovers via the OVERRIDES map below (keyed by internal db id).
 *
 * Reads SofaScore squads + schedule live; needs no API key.
 */
import pg from "pg";

import type { ProviderFixture, ProviderSquad } from "../src/data/provider/types.js";
import { createBrowserFetch, makeSofaProvider } from "./sofascore-browser-fetch.js";

const APPLY = process.argv.includes("--apply");

/** Manual ID overrides for names the matcher can't resolve. */
const TEAM_OVERRIDES: Record<number, string> = {};   // db national_team.id -> sofascore team id
const PLAYER_OVERRIDES: Record<number, string> = {
  // Resolved via SofaScore search (not in the squad-list endpoint, or
  // transliterated differently). db player.id -> sofascore player id.
  119: "1106603",  // Agustin Giay [Argentina] -> Agustín Giay
  365: "1048422",  // Hugo Ekitike [France] -> Hugo Ekitiké
  1025: "848287",  // Evan N'Dicka [Ivory Coast] -> Evan Ndicka (AS Roma)
  1103: "358880",  // Dostonbek Xamdamov [Uzbekistan] -> Dostonbek Khamdamov
};  // db player.id        -> sofascore player id
const FIXTURE_OVERRIDES: Record<number, string> = {}; // db fixture.id       -> sofascore event id

// --- name normalization -----------------------------------------------------

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const tokens = (s: string) => norm(s).split(" ").filter(Boolean);

/**
 * Canonical team name: collapse football-data vs SofaScore naming differences
 * (acronyms, transliterations, word order) to one key so the two sides match.
 */
const TEAM_ALIASES: Record<string, string> = {
  usa: "united states",
  "united states": "united states",
  turkey: "turkiye",
  turkiye: "turkiye",
  "cape verde": "cape verde",
  "cape verde islands": "cape verde",
  "cabo verde": "cape verde",
  "congo dr": "congo dr",
  "dr congo": "congo dr",
  "ivory coast": "ivory coast",
  "cote d ivoire": "ivory coast",
  "south korea": "korea republic",
  "korea republic": "korea republic",
};
function canonTeam(name: string): string {
  const n = norm(name);
  if (TEAM_ALIASES[n]) return TEAM_ALIASES[n];
  // Word-order-insensitive fallback (e.g. "Congo DR" vs "DR Congo").
  return tokens(name).sort().join(" ");
}

/** Token set of a name, as a Set for overlap math. */
const tokenSet = (s: string) => new Set(tokens(s));
const isSubset = (a: Set<string>, b: Set<string>) => [...a].every((t) => b.has(t));

/**
 * Best SofaScore candidate for a db player within one team. Returns the match
 * only when it is UNAMBIGUOUS — a single clear winner — so we never silently
 * bind a rostered player to the wrong person. Stages, most to least strict:
 *   1. exact normalized full name
 *   2. token-subset either direction (e.g. "Cucurella" ⊆ "Marc Cucurella")
 *   3. shared surname (last token), unique
 *   4. token overlap ≥ 2 OR (≥1 and one side is a single token), unique best
 */
function matchPlayer(
  dbName: string,
  candidates: Array<{ id: string; name: string }>,
): { id: string; name: string } | null {
  const dn = norm(dbName);
  const exact = candidates.filter((c) => norm(c.name) === dn);
  if (exact.length === 1) return exact[0]!;

  const dset = tokenSet(dbName);
  const subset = candidates.filter((c) => {
    const cs = tokenSet(c.name);
    return isSubset(dset, cs) || isSubset(cs, dset);
  });
  if (subset.length === 1) return subset[0]!;

  const dLast = tokens(dbName).at(-1);
  const surname = candidates.filter((c) => tokens(c.name).at(-1) === dLast);
  if (dLast && surname.length === 1) return surname[0]!;

  // Token overlap scoring.
  const scored = candidates
    .map((c) => {
      const cs = tokenSet(c.name);
      const shared = [...dset].filter((t) => cs.has(t)).length;
      return { c, shared, min: Math.min(dset.size, cs.size) };
    })
    .filter((s) => s.shared >= 2 || (s.shared >= 1 && s.min === 1))
    .sort((a, b) => b.shared - a.shared);
  if (scored.length === 1) return scored[0]!.c;
  if (scored.length > 1 && scored[0]!.shared > scored[1]!.shared) return scored[0]!.c;
  return null;
}

// --- main --------------------------------------------------------------------

async function main() {
  const url = process.env["DIRECT_DATABASE_URL"] || process.env["DATABASE_URL"];
  if (!url) throw new Error("DATABASE_URL / DIRECT_DATABASE_URL not set");

  console.log(`Mode: ${APPLY ? "APPLY (will write in a transaction)" : "DRY RUN (no writes)"}\n`);

  // 1) Pull SofaScore reference data via a real browser. Cloudflare needs BOTH
  //    a cf_clearance cookie (the browser warm-up obtains it) AND the
  //    x-requested-with header (forwarded into the in-page fetch). Node alone
  //    has the header but not the clearance/TLS, so it gets 403.
  console.log("Launching browser for SofaScore (set SOFA_HEADFUL=1 if it stalls)…");
  const browser = await createBrowserFetch();
  let squads: ProviderSquad[];
  let fixtures: ProviderFixture[];
  try {
    const provider = makeSofaProvider(process.env, browser.fetchImpl);
    console.log("Fetching SofaScore squads + schedule…");
    squads = await provider.fetchSquads();
    fixtures = await provider.fetchSchedule();
  } finally {
    await browser.close();
  }
  const ssPlayerCount = squads.reduce((n, s) => n + s.players.length, 0);
  console.log(`  SofaScore: ${squads.length} teams, ${ssPlayerCount} players, ${fixtures.length} fixtures\n`);

  // 2) Load current DB rows.
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const dbTeams = (await c.query(
    `select id, name, source_team_id from national_team order by id`,
  )).rows as Array<{ id: number; name: string; source_team_id: string }>;
  const dbPlayers = (await c.query(
    `select id, full_name, national_team_id, source_player_id from player order by id`,
  )).rows as Array<{ id: number; full_name: string; national_team_id: number; source_player_id: string }>;
  const dbFixtures = (await c.query(
    `select id, home_team_id, away_team_id, kickoff_utc, source_fixture_id from fixture order by id`,
  )).rows as Array<{ id: number; home_team_id: number; away_team_id: number; kickoff_utc: Date; source_fixture_id: string }>;

  // Players that appear on a drafted roster or draft pick — these MUST match.
  const rostered = new Set<number>(
    (await c.query(
      `select player_id from roster_slot
       union select player_id from draft_pick`,
    )).rows.map((r: { player_id: number }) => r.player_id),
  );

  // 3) Team crosswalk (by canonical name — handles USA, Türkiye, Cabo Verde,
  //    DR Congo, Côte d'Ivoire, etc.).
  const ssTeamByCanon = new Map<string, { id: string; name: string }>();
  for (const sq of squads) ssTeamByCanon.set(canonTeam(sq.team.name), { id: sq.team.sourceTeamId, name: sq.team.name });

  const teamMap = new Map<number, string>(); // db team id -> ss team id
  const teamUnmatched: typeof dbTeams = [];
  for (const t of dbTeams) {
    if (TEAM_OVERRIDES[t.id]) { teamMap.set(t.id, TEAM_OVERRIDES[t.id]!); continue; }
    const hit = ssTeamByCanon.get(canonTeam(t.name));
    if (hit) teamMap.set(t.id, hit.id);
    else teamUnmatched.push(t);
  }

  // 4) Player crosswalk (within matched team, exact then loose).
  // Index SofaScore players by their SS team id.
  const ssPlayersByTeam = new Map<string, Array<{ id: string; name: string }>>();
  for (const sq of squads) {
    const arr = ssPlayersByTeam.get(sq.team.sourceTeamId) ?? [];
    for (const p of sq.players) arr.push({ id: p.sourcePlayerId, name: p.fullName });
    ssPlayersByTeam.set(sq.team.sourceTeamId, arr);
  }

  const playerMap = new Map<number, string>();
  const playerUnmatched: Array<{ id: number; full_name: string; team: string; rostered: boolean }> = [];
  const rosteredMatches: Array<{ db: string; ss: string; team: string }> = [];
  for (const p of dbPlayers) {
    if (PLAYER_OVERRIDES[p.id]) { playerMap.set(p.id, PLAYER_OVERRIDES[p.id]!); continue; }
    const ssTeamId = teamMap.get(p.national_team_id);
    const teamName = dbTeams.find((t) => t.id === p.national_team_id)?.name ?? "?";
    const candidates = ssTeamId ? ssPlayersByTeam.get(ssTeamId) ?? [] : [];

    const hit = matchPlayer(p.full_name, candidates);
    if (hit) {
      playerMap.set(p.id, hit.id);
      if (rostered.has(p.id)) rosteredMatches.push({ db: p.full_name, ss: hit.name, team: teamName });
    } else {
      playerUnmatched.push({ id: p.id, full_name: p.full_name, team: teamName, rostered: rostered.has(p.id) });
    }
  }

  // 5) Fixture crosswalk. Match on the UNORDERED team pair (SofaScore and
  //    football-data disagree on which side is "home" — e.g. the opener is
  //    "USA v Paraguay" here but "paraguay-usa" there), disambiguated by the
  //    closest kickoff time.
  const minute = (d: Date) => new Date(d).toISOString().slice(0, 16);
  const pairKey = (a: string, b: string) => [a, b].sort().join("|");
  const ssByPair = new Map<string, Array<{ id: string; kickoff: number }>>();
  for (const f of fixtures) {
    const k = pairKey(f.sourceHomeTeamId, f.sourceAwayTeamId);
    const arr = ssByPair.get(k) ?? [];
    arr.push({ id: f.sourceFixtureId, kickoff: new Date(f.kickoffUtc).getTime() });
    ssByPair.set(k, arr);
  }
  const fixtureMap = new Map<number, string>();
  const fixtureUnmatched: Array<{ id: number; desc: string }> = [];
  for (const f of dbFixtures) {
    if (FIXTURE_OVERRIDES[f.id]) { fixtureMap.set(f.id, FIXTURE_OVERRIDES[f.id]!); continue; }
    const homeSS = teamMap.get(f.home_team_id);
    const awaySS = teamMap.get(f.away_team_id);
    const homeName = dbTeams.find((t) => t.id === f.home_team_id)?.name ?? "?";
    const awayName = dbTeams.find((t) => t.id === f.away_team_id)?.name ?? "?";
    let hit: string | undefined;
    if (homeSS && awaySS) {
      const cands = ssByPair.get(pairKey(homeSS, awaySS)) ?? [];
      const want = new Date(f.kickoff_utc).getTime();
      // Closest kickoff within 1 day disambiguates a group game from a later
      // knockout rematch of the same pair.
      let best: { id: string; diff: number } | null = null;
      for (const cd of cands) {
        const diff = Math.abs(cd.kickoff - want);
        if (diff <= 24 * 60 * 60 * 1000 && (!best || diff < best.diff)) best = { id: cd.id, diff };
      }
      hit = best?.id;
    }
    if (hit) fixtureMap.set(f.id, hit);
    else fixtureUnmatched.push({ id: f.id, desc: `${homeName} v ${awayName} @ ${minute(f.kickoff_utc)}` });
  }

  // 6) Report.
  const rosteredUnmatched = playerUnmatched.filter((p) => p.rostered);
  console.log("=== CROSSWALK SUMMARY ===");
  console.log(`Teams    : ${teamMap.size}/${dbTeams.length} matched, ${teamUnmatched.length} unmatched`);
  console.log(`Players  : ${playerMap.size}/${dbPlayers.length} matched, ${playerUnmatched.length} unmatched (${rosteredUnmatched.length} of them ROSTERED)`);
  console.log(`Fixtures : ${fixtureMap.size}/${dbFixtures.length} matched, ${fixtureUnmatched.length} unmatched\n`);

  if (rosteredMatches.length) {
    console.log("-- ROSTERED player matches (verify db name → SofaScore name) --");
    for (const m of rosteredMatches.sort((a, b) => a.team.localeCompare(b.team))) {
      const flag = norm(m.db) === norm(m.ss) ? "  " : "≈ "; // ≈ = fuzzy, eyeball it
      console.log(`  ${flag}[${m.team}] "${m.db}"  →  "${m.ss}"`);
    }
    console.log();
  }
  if (teamUnmatched.length) {
    console.log("-- Unmatched TEAMS (add to TEAM_OVERRIDES) --");
    for (const t of teamUnmatched) console.log(`  db#${t.id}  "${t.name}"  (fd src=${t.source_team_id})`);
    console.log();
  }
  if (playerUnmatched.length) {
    console.log("-- Unmatched PLAYERS (★ = rostered, must resolve before --apply) --");
    for (const p of playerUnmatched.sort((a, b) => Number(b.rostered) - Number(a.rostered))) {
      console.log(`  ${p.rostered ? "★" : " "} db#${p.id}  "${p.full_name}"  [${p.team}]`);
    }
    console.log();
  }
  if (fixtureUnmatched.length) {
    console.log("-- Unmatched FIXTURES (add to FIXTURE_OVERRIDES) --");
    for (const f of fixtureUnmatched) console.log(`  db#${f.id}  ${f.desc}`);
    console.log();
  }

  // 7) Apply (guarded).
  if (!APPLY) {
    console.log("DRY RUN complete — nothing written. Re-run with --apply once rostered players are all matched.");
    await c.end();
    return;
  }
  if (rosteredUnmatched.length > 0) {
    console.log(`REFUSING to apply: ${rosteredUnmatched.length} rostered player(s) unmatched. Add them to PLAYER_OVERRIDES.`);
    await c.end();
    process.exit(1);
  }

  // 6b) Collision guard. source_player_id / source_fixture_id are UNIQUE, so
  //     two db rows mapping to one SofaScore id would violate the constraint.
  //     This happens because the DB has duplicate player rows (same person
  //     imported twice). Keep the rostered copy (or lowest id) and drop the
  //     rest from the write set. Abort only if two ROSTERED rows collide.
  const nameById = new Map<number, string>(dbPlayers.map((p) => [p.id, p.full_name]));
  const byTarget = new Map<string, number[]>();
  for (const [dbId, ssId] of playerMap) {
    const arr = byTarget.get(ssId) ?? [];
    arr.push(dbId);
    byTarget.set(ssId, arr);
  }
  let abort = false;
  for (const [ssId, dbIds] of byTarget) {
    if (dbIds.length < 2) continue;
    const rosteredDup = dbIds.filter((id) => rostered.has(id));
    if (rosteredDup.length > 1) {
      console.log(
        `COLLISION: rostered rows ${rosteredDup.map((id) => `db#${id} "${nameById.get(id)}"`).join(", ")} ` +
          `all map to SofaScore ${ssId}. These are duplicate roster entries — resolve in the DB first.`,
      );
      abort = true;
      continue;
    }
    const keep = rosteredDup[0] ?? Math.min(...dbIds);
    for (const id of dbIds) {
      if (id !== keep) {
        playerMap.delete(id);
        console.log(`  dedup: dropping db#${id} "${nameById.get(id)}" (duplicate of db#${keep}, both → SofaScore ${ssId})`);
      }
    }
  }
  if (abort) {
    console.log("REFUSING to apply due to rostered collisions above.");
    await c.end();
    process.exit(1);
  }

  // Same dedup for fixtures (source_fixture_id is unique). Keep lowest db id.
  const fxByTarget = new Map<string, number[]>();
  for (const [dbId, ssId] of fixtureMap) {
    const arr = fxByTarget.get(ssId) ?? [];
    arr.push(dbId);
    fxByTarget.set(ssId, arr);
  }
  for (const [ssId, dbIds] of fxByTarget) {
    if (dbIds.length < 2) continue;
    const keep = Math.min(...dbIds);
    for (const id of dbIds) {
      if (id !== keep) {
        fixtureMap.delete(id);
        console.log(`  dedup: dropping fixture db#${id} (duplicate of db#${keep}, both → SofaScore ${ssId})`);
      }
    }
  }

  console.log("Applying in a transaction (two-phase to avoid swap collisions)…");
  try {
    await c.query("begin");

    // Phase 1: park every remapped row on a unique non-numeric sentinel, so no
    // old id lingers to collide when we assign the real SofaScore ids. The
    // `__rmp:<id>` form is unique (id is PK) and can't equal any numeric id.
    for (const dbId of teamMap.keys()) {
      await c.query(`update national_team set source_team_id = $1 where id = $2`, [`__rmp:${dbId}`, dbId]);
    }
    for (const dbId of playerMap.keys()) {
      await c.query(`update player set source_player_id = $1 where id = $2`, [`__rmp:${dbId}`, dbId]);
    }
    for (const dbId of fixtureMap.keys()) {
      await c.query(`update fixture set source_fixture_id = $1 where id = $2`, [`__rmp:${dbId}`, dbId]);
    }

    // Phase 2: assign the real SofaScore ids.
    for (const [dbId, ssId] of teamMap) {
      await c.query(`update national_team set source_team_id = $1, updated_at = now() where id = $2`, [ssId, dbId]);
    }
    for (const [dbId, ssId] of playerMap) {
      await c.query(`update player set source_player_id = $1, updated_at = now() where id = $2`, [ssId, dbId]);
    }
    for (const [dbId, ssId] of fixtureMap) {
      await c.query(`update fixture set source_fixture_id = $1, updated_at = now() where id = $2`, [ssId, dbId]);
    }
    await c.query("commit");
    console.log(`Committed: ${teamMap.size} teams, ${playerMap.size} players, ${fixtureMap.size} fixtures remapped.`);
    console.log("Next: set STATS_PROVIDER=sofascore, then `npm run cli ingest:all` and `score:recompute`.");
  } catch (e) {
    await c.query("rollback");
    console.error("Rolled back:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

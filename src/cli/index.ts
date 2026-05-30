/**
 * Ingestion + scoring + league + draft + standings CLI.
 *
 * Subcommands:
 *   ingest:squads | ingest:schedule | ingest:fixture-stats <id>
 *   score:recompute [sourceFixtureId]
 *   manager:create <uid> <name> <email>
 *   league:create <ownerUid> <name> [maxManagers]
 *   league:invite <leagueId> [email]
 *   league:join <token> <managerUid>
 *   roster:add <fantasyTeamId> <sourcePlayerId>
 *   roster:show <fantasyTeamId>
 *   player:rank <sourcePlayerId> <rank>
 *   draft:create <leagueId> [pickTimerHours]
 *   draft:start <leagueId>
 *   draft:pick <leagueId> <fantasyTeamId> <sourcePlayerId>
 *   draft:tick
 *   draft:status <leagueId>
 *   standings:show <leagueId> [--periods]
 *
 * Provider selection (only consulted by ingest:* commands):
 *   - Default: ApiFootballProvider, from environment variables.
 *   - If MOCK_FIXTURES_DIR is set, FixtureMockProvider is used instead.
 *
 * Non-ingest commands construct the provider lazily, so an API key is not
 * required to run scoring, league, draft, or standings operations.
 */

import { eq } from "drizzle-orm";
import { pathToFileURL } from "node:url";

import { closeDb, createDb, type Db } from "../data/db/client.js";
import { draftRoom, fantasyTeam, fixture, manager, player, statLine } from "../data/db/schema.js";
import { ConsoleNotifier } from "../data/draft/notifier.js";
import {
  createDraftRoom,
  getDraftState,
  makePick,
  processExpiredPicks,
  startDraft,
} from "../data/draft/service.js";
import { ingestFixtureStats } from "../data/ingest/fixture-stats.js";
import { getUningestedFinishedFixtures } from "../data/ingest/pending.js";
import { ingestSchedule } from "../data/ingest/schedule.js";
import { ingestSquads } from "../data/ingest/squads.js";
import { formatSummary } from "../data/ingest/summary.js";
import {
  acceptInvite,
  createLeague,
  createManager,
  inviteManager,
} from "../data/league/service.js";
import { apiFootballFromEnv } from "../data/provider/api-football.js";
import { footballDataFromEnv } from "../data/provider/football-data.js";
import { FixtureMockProvider } from "../data/provider/mock.js";
import type { StatsProvider } from "../data/provider/types.js";
import { addPlayerToRoster, getRoster, getRosterCounts } from "../data/roster/service.js";
import { recomputeAll, recomputeForFixture } from "../data/scoring/recompute.js";
import { oddsProviderFromEnv } from "../data/odds/odds-provider.js";
import { recomputeProjections } from "../data/projection/recompute-projections.js";
import { DEFAULT_RULESET } from "../data/scoring/ruleset.js";
import { computeStandings } from "../data/standings/standings.js";

type SubcommandResult = void;
interface SubcommandContext {
  db: Db;
  getProvider: () => StatsProvider;
  args: string[];
}
type Subcommand = (ctx: SubcommandContext) => Promise<SubcommandResult>;

async function managerByUid(db: Db, uid: string) {
  const [m] = await db.select().from(manager).where(eq(manager.firebaseUid, uid));
  if (!m) throw new Error(`no manager with firebase uid ${uid}`);
  return m;
}

async function draftRoomByLeague(db: Db, leagueId: number) {
  const [r] = await db.select().from(draftRoom).where(eq(draftRoom.leagueId, leagueId));
  if (!r) throw new Error(`league ${leagueId} has no draft room`);
  return r;
}

async function playerBySourceId(db: Db, sourceId: string) {
  const [p] = await db.select().from(player).where(eq(player.sourcePlayerId, sourceId));
  if (!p) throw new Error(`no player with source id ${sourceId}`);
  return p;
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  "ingest:squads": async ({ db, getProvider }) => {
    const result = await ingestSquads(db, getProvider());
    console.log(`squads.teams   ${formatSummary(result.teams)}`);
    console.log(`squads.players ${formatSummary(result.players)}`);
  },
  "ingest:schedule": async ({ db, getProvider }) => {
    const summary = await ingestSchedule(db, getProvider());
    console.log(`schedule       ${formatSummary(summary)}`);
  },
  "ingest:fixture-stats": async ({ db, getProvider, args }) => {
    const sourceFixtureId = args[0];
    if (!sourceFixtureId) {
      throw new Error("usage: ingest:fixture-stats <sourceFixtureId>");
    }
    const summary = await ingestFixtureStats(db, getProvider(), sourceFixtureId);
    console.log(`stats fx=${sourceFixtureId} ${formatSummary(summary)}`);
  },
  "fixtures:list": async ({ db }) => {
    const rows = await db
      .select({
        id: fixture.id,
        sourceFixtureId: fixture.sourceFixtureId,
        stage: fixture.stage,
        kickoff: fixture.kickoffUtc,
        status: fixture.status,
      })
      .from(fixture)
      .orderBy(fixture.kickoffUtc);
    if (rows.length === 0) {
      console.log("(no fixtures -- run ingest:schedule first)");
      return;
    }
    // Count stat_line rows per fixture for the coverage column.
    const statRows = await db
      .select({ fixtureId: statLine.fixtureId })
      .from(statLine);
    const statCount = new Map<number, number>();
    for (const r of statRows) {
      statCount.set(r.fixtureId, (statCount.get(r.fixtureId) ?? 0) + 1);
    }
    console.log(
      "sourceFixtureId        stage        kickoff (UTC)             status      stats",
    );
    for (const r of rows) {
      const stats = statCount.get(r.id) ?? 0;
      const statsLabel = stats > 0 ? `${stats} rows` : "none";
      const kickoff = r.kickoff.toISOString().slice(0, 16).replace("T", " ");
      console.log(
        `${r.sourceFixtureId.padEnd(22)} ${r.stage.padEnd(12)} ${kickoff}  ${r.status.padEnd(11)} ${statsLabel}`,
      );
    }
    console.log(`\n${rows.length} fixture(s) total`);
  },
  "ingest:all-finished": async ({ db, getProvider }) => {
    const pending = await getUningestedFinishedFixtures(db);
    if (pending.length === 0) {
      console.log("nothing to do -- all FINISHED fixtures already have stats");
      return;
    }
    console.log(`ingesting stats for ${pending.length} fixture(s)...`);
    let ingested = 0;
    for (const fx of pending) {
      const summary = await ingestFixtureStats(db, getProvider(), fx.sourceFixtureId);
      console.log(`  fx=${fx.sourceFixtureId} stage=${fx.stage} ${JSON.stringify(summary)}`);
      ingested += 1;
    }
    console.log(`\ningested ${ingested} fixture(s) -- recomputing scores...`);
    const ruleset = DEFAULT_RULESET;
    const summary = await recomputeAll(db, ruleset);
    console.log(`score all ruleset=${ruleset.version} ${formatSummary(summary)}`);
  },
  "ingest:odds": async ({ db }) => {
    const env = process.env as NodeJS.ProcessEnv;
    if (!env["ODDS_API_KEY"]) {
      throw new Error("ODDS_API_KEY is not set. Add it to your .env file.");
    }
    const oddsProvider = oddsProviderFromEnv(env);
    console.log("fetching odds from The Odds API...");
    const oddsSummary = await oddsProvider.ingestOdds(db);
    console.log(
      `odds: fetched=${oddsSummary.fetched} matched=${oddsSummary.matched} skipped=${oddsSummary.skipped}`,
    );
    if (oddsSummary.matched === 0 && oddsSummary.skipped === 0) {
      console.log(
        "  (no fixtures matched -- run ingest:schedule first, or check the tournament hasn't started yet)",
      );
      return;
    }
    console.log("recomputing projections...");
    const projSummary = await recomputeProjections(db, DEFAULT_RULESET);
    console.log(
      `projections: fixtures=${projSummary.fixturesProcessed} players=${projSummary.playersProjected} ruleset=${projSummary.rulesetVersion}`,
    );
  },
  "provider:test": async ({ getProvider }) => {
    // Diagnostic: verify API connectivity and report raw result counts.
    // Run this first if ingest:squads returns all zeros.
    const provider = getProvider();
    // Access internal cfg via cast to inspect what league/season we're hitting.
    const cfg = (provider as unknown as { cfg: { leagueId: number; season: number; baseUrl: string } }).cfg;
    console.log(`provider: ${cfg.baseUrl}  league=${cfg.leagueId}  season=${cfg.season}`);
    console.log("fetching squads (this calls /standings then /teams then /players/squads per team)...");
    try {
      const squads = await provider.fetchSquads();
      console.log(`fetchSquads => ${squads.length} team(s)`);
      if (squads.length > 0) {
        const totalPlayers = squads.reduce((n, s) => n + s.players.length, 0);
        console.log(`  sample team: ${squads[0]!.team.name}  players: ${squads[0]!.players.length}`);
        console.log(`  total players across all teams: ${totalPlayers}`);
      }
    } catch (err) {
      console.error("fetchSquads FAILED:", err instanceof Error ? err.message : String(err));
    }
  },
  "score:recompute": async ({ db, args }) => {
    const ruleset = DEFAULT_RULESET;
    const target = args[0];
    if (target) {
      const summary = await recomputeForFixture(db, ruleset, target);
      console.log(
        `score fx=${target} ruleset=${ruleset.version} ${formatSummary(summary)}`,
      );
    } else {
      const summary = await recomputeAll(db, ruleset);
      console.log(`score all ruleset=${ruleset.version} ${formatSummary(summary)}`);
    }
  },
  "manager:create": async ({ db, args }) => {
    const [uid, displayName, email] = args;
    if (!uid || !displayName || !email) {
      throw new Error("usage: manager:create <firebaseUid> <displayName> <email>");
    }
    const m = await createManager(db, { firebaseUid: uid, displayName, email });
    console.log(`manager id=${m.id} uid=${m.firebaseUid} name=${m.displayName}`);
  },
  "league:create": async ({ db, args }) => {
    const [ownerUid, name, maxRaw] = args;
    if (!ownerUid || !name) {
      throw new Error("usage: league:create <ownerFirebaseUid> <name> [maxManagers]");
    }
    const owner = await managerByUid(db, ownerUid);
    const result = await createLeague(db, {
      ownerManagerId: owner.id,
      name,
      ...(maxRaw ? { maxManagers: Number(maxRaw) } : {}),
    });
    console.log(
      `league id=${result.league.id} name="${result.league.name}" ` +
        `max=${result.league.maxManagers}`,
    );
    console.log(`owner team id=${result.ownerTeam.id} name="${result.ownerTeam.name}"`);
  },
  "league:invite": async ({ db, args }) => {
    const [leagueIdRaw, email] = args;
    if (!leagueIdRaw) throw new Error("usage: league:invite <leagueId> [email]");
    const invite = await inviteManager(db, {
      leagueId: Number(leagueIdRaw),
      ...(email ? { email } : {}),
    });
    console.log(`invite id=${invite.id} token=${invite.token}`);
  },
  "league:join": async ({ db, args }) => {
    const [token, managerUid] = args;
    if (!token || !managerUid) {
      throw new Error("usage: league:join <token> <managerFirebaseUid>");
    }
    const m = await managerByUid(db, managerUid);
    const result = await acceptInvite(db, { token, managerId: m.id });
    console.log(
      `joined league id=${result.league.id} name="${result.league.name}" ` +
        `as team id=${result.team.id}`,
    );
  },
  "roster:add": async ({ db, args }) => {
    const [teamIdRaw, sourcePlayerId] = args;
    if (!teamIdRaw || !sourcePlayerId) {
      throw new Error("usage: roster:add <fantasyTeamId> <sourcePlayerId>");
    }
    const p = await playerBySourceId(db, sourcePlayerId);
    const result = await addPlayerToRoster(db, {
      fantasyTeamId: Number(teamIdRaw),
      playerId: p.id,
    });
    const c = result.counts;
    console.log(
      `drafted ${p.fullName} (${p.position}) -> team ${teamIdRaw}  ` +
        `[GK ${c.GK} DEF ${c.DEF} MID ${c.MID} FWD ${c.FWD}]`,
    );
  },
  "roster:show": async ({ db, args }) => {
    const [teamIdRaw] = args;
    if (!teamIdRaw) throw new Error("usage: roster:show <fantasyTeamId>");
    const teamId = Number(teamIdRaw);
    const [team] = await db.select().from(fantasyTeam).where(eq(fantasyTeam.id, teamId));
    if (!team) throw new Error(`no fantasy team with id ${teamId}`);
    const roster = await getRoster(db, teamId);
    const counts = await getRosterCounts(db, teamId);
    console.log(`team id=${team.id} name="${team.name}"  (${roster.length}/23 players)`);
    console.log(`  GK ${counts.GK}  DEF ${counts.DEF}  MID ${counts.MID}  FWD ${counts.FWD}`);
    for (const entry of roster) {
      console.log(`  ${entry.player.position.padEnd(3)} ${entry.player.fullName}`);
    }
  },
  "player:rank": async ({ db, args }) => {
    const [sourcePlayerId, rankRaw] = args;
    if (!sourcePlayerId || rankRaw === undefined) {
      throw new Error("usage: player:rank <sourcePlayerId> <rank>");
    }
    const p = await playerBySourceId(db, sourcePlayerId);
    await db
      .update(player)
      .set({ draftRank: Number(rankRaw), updatedAt: new Date() })
      .where(eq(player.id, p.id));
    console.log(`set draft_rank=${rankRaw} for ${p.fullName}`);
  },
  "draft:create": async ({ db, args }) => {
    const [leagueIdRaw, timerRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: draft:create <leagueId> [pickTimerHours]");
    const room = await createDraftRoom(db, {
      leagueId: Number(leagueIdRaw),
      ...(timerRaw ? { pickTimerHours: Number(timerRaw) } : {}),
    });
    console.log(
      `draft room id=${room.id} league=${room.leagueId} ` +
        `timer=${room.pickTimerHours}h status=${room.status}`,
    );
  },
  "draft:start": async ({ db, args }) => {
    const [leagueIdRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: draft:start <leagueId>");
    const room = await draftRoomByLeague(db, Number(leagueIdRaw));
    const started = await startDraft(db, {
      draftRoomId: room.id,
      notifier: new ConsoleNotifier(),
    });
    console.log(
      `draft started: ${started.totalPicks} picks, pick 1 on the clock, ` +
        `deadline ${started.currentPickDeadline?.toISOString()}`,
    );
  },
  "draft:pick": async ({ db, args }) => {
    const [leagueIdRaw, teamIdRaw, sourcePlayerId] = args;
    if (!leagueIdRaw || !teamIdRaw || !sourcePlayerId) {
      throw new Error("usage: draft:pick <leagueId> <fantasyTeamId> <sourcePlayerId>");
    }
    const room = await draftRoomByLeague(db, Number(leagueIdRaw));
    const p = await playerBySourceId(db, sourcePlayerId);
    const result = await makePick(db, {
      draftRoomId: room.id,
      fantasyTeamId: Number(teamIdRaw),
      playerId: p.id,
      notifier: new ConsoleNotifier(),
    });
    console.log(
      `pick #${result.pickNumber} (round ${result.round}): team ${teamIdRaw} ` +
        `selected ${p.fullName} (${p.position})`,
    );
  },
  "draft:tick": async ({ db }) => {
    const result = await processExpiredPicks(db, { notifier: new ConsoleNotifier() });
    console.log(
      `tick: ${result.autopicks} autopick(s) across ${result.draftsTouched} draft(s)`,
    );
  },
  "draft:status": async ({ db, args }) => {
    const [leagueIdRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: draft:status <leagueId>");
    const room = await draftRoomByLeague(db, Number(leagueIdRaw));
    const state = await getDraftState(db, room.id);
    console.log(
      `draft id=${state.draftRoom.id} status=${state.draftRoom.status} ` +
        `picks=${state.picksMade}/${state.draftRoom.totalPicks}`,
    );
    if (state.onClock) {
      console.log(
        `  on the clock: pick #${state.onClock.pickNumber} (round ${state.onClock.round}) ` +
          `team ${state.onClock.fantasyTeamId}, deadline ` +
          `${state.draftRoom.currentPickDeadline?.toISOString()}`,
      );
    }
  },
  "standings:show": async ({ db, args }) => {
    const [leagueIdRaw, verboseRaw] = args;
    if (!leagueIdRaw) throw new Error("usage: standings:show <leagueId> [--periods]");
    const verbose = verboseRaw === "--periods";
    const standings = await computeStandings(db, Number(leagueIdRaw));
    if (standings.length === 0) {
      console.log("(no teams in this league)");
      return;
    }
    console.log("rank  total  team");
    for (const e of standings) {
      console.log(
        `${String(e.rank).padStart(4)}  ${String(e.total).padStart(5)}  ${e.teamName}`,
      );
      if (verbose) {
        for (const p of e.periods) {
          if (p.points > 0) {
            console.log(`         ${p.stage.padEnd(12)} ${p.formation}  ${p.points} pts`);
          }
        }
      }
    }
  },
};

function selectProvider(env: NodeJS.ProcessEnv): StatsProvider {
  const mockDir = env["MOCK_FIXTURES_DIR"];
  if (mockDir) return new FixtureMockProvider({ root: mockDir });
  // Prefer football-data.org if its key is set; fall back to API-Football.
  if (env["FOOTBALL_DATA_KEY"]) return footballDataFromEnv(env);
  return apiFootballFromEnv(env);
}

export async function runCli(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const [name, ...rest] = argv;
  if (!name) {
    printUsage();
    throw new Error("no subcommand");
  }
  const handler = SUBCOMMANDS[name];
  if (!handler) {
    printUsage();
    throw new Error(`unknown subcommand: ${name}`);
  }
  const databaseUrl = env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");

  const db = createDb({ connectionString: databaseUrl, max: 2 });
  try {
    let memo: StatsProvider | undefined;
    const getProvider = () => (memo ??= selectProvider(env));
    await handler({ db, getProvider, args: rest });
  } finally {
    await closeDb(db);
  }
}

function printUsage(): void {
  console.error(
    [
      "Usage:",
      "  cli ingest:squads | ingest:schedule | ingest:fixture-stats <id> | ingest:all-finished",
      "  cli ingest:odds",
      "  cli fixtures:list",
      "  cli score:recompute [sourceFixtureId]",
      "  cli manager:create <firebaseUid> <displayName> <email>",
      "  cli league:create <ownerFirebaseUid> <name> [maxManagers]",
      "  cli league:invite <leagueId> [email]",
      "  cli league:join <token> <managerFirebaseUid>",
      "  cli roster:add <fantasyTeamId> <sourcePlayerId>",
      "  cli roster:show <fantasyTeamId>",
      "  cli player:rank <sourcePlayerId> <rank>",
      "  cli draft:create <leagueId> [pickTimerHours]",
      "  cli draft:start <leagueId>",
      "  cli draft:pick <leagueId> <fantasyTeamId> <sourcePlayerId>",
      "  cli draft:tick",
      "  cli draft:status <leagueId>",
      "  cli standings:show <leagueId> [--periods]",
      "",
      "Environment:",
      "  DATABASE_URL          Required.",
      "  API_FOOTBALL_KEY      Required for live ingest.",
      "  ODDS_API_KEY          Optional. Required for ingest:odds (projected points).",
      "  MOCK_FIXTURES_DIR     Optional. Use FixtureMockProvider against this dir.",
    ].join("\n"),
  );
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runCli(process.argv.slice(2)).then(
    () => process.exit(0),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}

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
 *
 * The per-command implementations live in ./commands/*.ts; this module just
 * assembles them into one SUBCOMMANDS map and wires up the runtime.
 */

import { pathToFileURL } from "node:url";

import { closeDb, createDb } from "../data/db/client.js";
import type { StatsProvider } from "../data/provider/types.js";
import { draftCommands } from "./commands/draft.js";
import { fixturesCommands } from "./commands/fixtures.js";
import { ingestCommands } from "./commands/ingest.js";
import { leaguesCommands } from "./commands/leagues.js";
import { oddsCommands } from "./commands/odds.js";
import { playersCommands } from "./commands/players.js";
import { rosterCommands } from "./commands/roster.js";
import { scoreCommands } from "./commands/score.js";
import { standingsCommands } from "./commands/standings.js";
import { selectProvider, type Subcommand } from "./helpers.js";

const SUBCOMMANDS: Record<string, Subcommand> = {
  ...ingestCommands,
  ...oddsCommands,
  ...fixturesCommands,
  ...scoreCommands,
  ...leaguesCommands,
  ...rosterCommands,
  ...playersCommands,
  ...draftCommands,
  ...standingsCommands,
};

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
      "  cli ingest:all        (schedule + stats + scores + odds, one command)",
      "  cli ingest:squads | ingest:schedule | ingest:fixture-stats <id> | ingest:all-finished",
      "  cli ingest:rankings <path/to/draft_import.csv>",
      "  cli ingest:odds",
      "  cli ingest:stage-odds  (per-team chance to reach R16/QF/SF/Final/Champion)",
      "  cli odds:sports [--all]  (list available Odds API markets / WC futures keys)",
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
      "  STATS_PROVIDER        Optional. api-football | football-data | mock | sportmonks.",
      "                        Auto-detects api-football/football-data if unset.",
      "  API_FOOTBALL_KEY      Recommended for the WC (shots/tackles/passes/saves;",
      "                        crosses entered by hand in /admin/stats).",
      "  FOOTBALL_DATA_KEY     football-data.org key (basic stats only).",
      "  SPORTMONKS_KEY        Dormant: no affordable WC data; needs STATS_PROVIDER=sportmonks.",
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

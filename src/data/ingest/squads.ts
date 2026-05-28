/**
 * Squad ingestion.
 *
 * Reads all 48 squads from the provider and upserts the `national_team` and
 * `player` tables. Idempotent: re-running produces identical state.
 *
 * Updates happen only when something actually changed (name, position, group,
 * team membership); unchanged rows are counted as skipped so the operator can
 * see at a glance that a re-run is a no-op.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import {
  nationalTeam,
  player,
  type NationalTeamRow,
  type PlayerRow,
  type Position,
} from "../db/schema.js";
import type { ProviderSquad, StatsProvider } from "../provider/types.js";
import { emptySummary, type IngestSummary } from "./summary.js";

export async function ingestSquads(
  db: Db,
  provider: StatsProvider,
): Promise<{ teams: IngestSummary; players: IngestSummary }> {
  const squads = await provider.fetchSquads();

  const teams = await upsertTeams(db, squads);
  const players = await upsertPlayers(db, squads);

  return { teams, players };
}

async function upsertTeams(db: Db, squads: ProviderSquad[]): Promise<IngestSummary> {
  const summary = emptySummary();

  // Pre-load existing teams keyed by sourceTeamId for a single round-trip.
  const existing = await db.select().from(nationalTeam);
  const byId = new Map<string, NationalTeamRow>(existing.map((r) => [r.sourceTeamId, r]));

  for (const sq of squads) {
    const row = byId.get(sq.team.sourceTeamId);
    if (!row) {
      await db.insert(nationalTeam).values({
        name: sq.team.name,
        sourceTeamId: sq.team.sourceTeamId,
        groupLabel: sq.team.groupLabel,
      });
      summary.inserted += 1;
      continue;
    }
    const changed = row.name !== sq.team.name || row.groupLabel !== sq.team.groupLabel;
    if (!changed) {
      summary.skipped += 1;
      continue;
    }
    await db
      .update(nationalTeam)
      .set({
        name: sq.team.name,
        groupLabel: sq.team.groupLabel,
        updatedAt: new Date(),
      })
      .where(eq(nationalTeam.id, row.id));
    summary.updated += 1;
  }
  return summary;
}

async function upsertPlayers(db: Db, squads: ProviderSquad[]): Promise<IngestSummary> {
  const summary = emptySummary();

  // Need the team-id mapping (sourceTeamId -> internal id) to set FKs.
  const teamRows = await db.select().from(nationalTeam);
  const teamIdBySource = new Map(teamRows.map((r) => [r.sourceTeamId, r.id]));

  const existingPlayers = await db.select().from(player);
  const byId = new Map<string, PlayerRow>(existingPlayers.map((r) => [r.sourcePlayerId, r]));

  for (const sq of squads) {
    const teamId = teamIdBySource.get(sq.team.sourceTeamId);
    if (teamId == null) {
      // Should never happen because we just upserted the team. Guard anyway.
      throw new Error(`team ${sq.team.sourceTeamId} missing after upsert`);
    }
    for (const p of sq.players) {
      const row = byId.get(p.sourcePlayerId);
      if (!row) {
        await db.insert(player).values({
          fullName: p.fullName,
          position: p.position satisfies Position,
          nationalTeamId: teamId,
          sourcePlayerId: p.sourcePlayerId,
        });
        summary.inserted += 1;
        continue;
      }
      const changed =
        row.fullName !== p.fullName ||
        row.position !== p.position ||
        row.nationalTeamId !== teamId;
      if (!changed) {
        summary.skipped += 1;
        continue;
      }
      await db
        .update(player)
        .set({
          fullName: p.fullName,
          position: p.position,
          nationalTeamId: teamId,
          updatedAt: new Date(),
        })
        .where(eq(player.id, row.id));
      summary.updated += 1;
    }
  }

  return summary;
}

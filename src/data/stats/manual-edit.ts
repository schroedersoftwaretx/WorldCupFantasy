/**
 * Manual stat-line editing (admin).
 *
 * The provider ingest path is the normal way stat_line rows are written, but
 * some data is unavailable from the free feeds (crosses, the per-keeper split
 * of saves across a substitution, etc.). This service lets an operator
 * hand-enter or correct any counter on a single (player, fixture) line.
 *
 * Two invariants make this safe:
 *   1. The row is flagged `manuallyEdited = true`, and ingest-fixture-stats
 *      refuses to overwrite a flagged row — so a later provider re-ingest can
 *      never clobber a correction.
 *   2. score_entry stays fully derived: the caller recomputes the fixture
 *      afterwards, so edited stats flow into points exactly like ingested ones.
 *
 * Editing is keyed on the INTERNAL player id + fixture id (not provider ids),
 * because the admin UI already resolved them.
 */
import { and, eq } from "drizzle-orm";

import type { Db } from "../db/client.js";
import { statLine, type StatLineRow } from "../db/schema.js";

/** The numeric counters an admin may edit. */
export const EDITABLE_STAT_FIELDS = [
  "minutesPlayed",
  "goals",
  "assists",
  "saves",
  "yellowCards",
  "redCards",
  "penaltiesScored",
  "penaltiesMissed",
  "penaltiesSaved",
  "ownGoals",
  "teamConcededInRegulationAndEt",
  "teamScoredInRegulationAndEt",
  "teamShootoutScored",
  "teamShootoutConceded",
  "shotsOnTarget",
  "shotsOffTarget",
  "tacklesSuccessful",
  "crosses",
  "passesCompleted",
  "keyPasses",
  "bigChancesCreated",
  "goalsConceded",
] as const;

export type EditableStatField = (typeof EDITABLE_STAT_FIELDS)[number];

export type StatEdit = Partial<Record<EditableStatField, number>>;

export interface ManualEditResult {
  /** Whether a row already existed (updated) or one was created (inserted). */
  action: "updated" | "inserted";
}

const EDITABLE_SET = new Set<string>(EDITABLE_STAT_FIELDS);

/**
 * Validate + coerce an untrusted edit payload into a clean partial. Unknown
 * keys are rejected; values must be finite non-negative integers (every
 * editable counter is a count).
 */
export function sanitizeStatEdit(input: Record<string, unknown>): StatEdit {
  const out: StatEdit = {};
  for (const [key, value] of Object.entries(input)) {
    if (!EDITABLE_SET.has(key)) {
      throw new Error(`unknown stat field: ${key}`);
    }
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new Error(`field ${key} must be a non-negative integer, got ${String(value)}`);
    }
    out[key as EditableStatField] = n;
  }
  return out;
}

/**
 * Apply a manual edit to one stat line, creating the row if absent. Always
 * sets the manual-edit lock so provider re-ingest will not overwrite it.
 */
export async function applyManualStatEdit(
  db: Db,
  args: {
    playerId: number;
    fixtureId: number;
    edit: StatEdit;
    note?: string | null;
  },
): Promise<ManualEditResult> {
  const { playerId, fixtureId, edit, note } = args;

  const existing = (await db
    .select()
    .from(statLine)
    .where(and(eq(statLine.playerId, playerId), eq(statLine.fixtureId, fixtureId)))) as StatLineRow[];

  if (existing.length === 0) {
    await db.insert(statLine).values({
      playerId,
      fixtureId,
      ...edit,
      manuallyEdited: true,
      manualNote: note ?? null,
      sourceRevision: "manual",
    });
    return { action: "inserted" };
  }

  await db
    .update(statLine)
    .set({
      ...edit,
      manuallyEdited: true,
      manualNote: note ?? null,
      ingestedAt: new Date(),
    })
    .where(and(eq(statLine.playerId, playerId), eq(statLine.fixtureId, fixtureId)));
  return { action: "updated" };
}

/**
 * Shared CLI helpers: subcommand types, DB lookups, provider selection, and
 * the name-matching utilities used by ingest:rankings.
 *
 * Extracted from the original src/cli/index.ts so that the per-domain command
 * modules in ./commands can share them without circular imports.
 */

import { eq } from "drizzle-orm";

import type { Db } from "../data/db/client.js";
import { draftRoom, manager, player } from "../data/db/schema.js";
import { statsProviderFromEnv } from "../data/provider/select.js";
import type { StatsProvider } from "../data/provider/types.js";

// Re-exported so command modules can import formatSummary from a single place.
export { formatSummary } from "../data/ingest/summary.js";

export type SubcommandResult = void;
export interface SubcommandContext {
  db: Db;
  getProvider: () => StatsProvider;
  args: string[];
}
export type Subcommand = (ctx: SubcommandContext) => Promise<SubcommandResult>;

export async function managerByUid(db: Db, uid: string) {
  const [m] = await db.select().from(manager).where(eq(manager.firebaseUid, uid));
  if (!m) throw new Error(`no manager with firebase uid ${uid}`);
  return m;
}

export async function draftRoomByLeague(db: Db, leagueId: number) {
  const [r] = await db.select().from(draftRoom).where(eq(draftRoom.leagueId, leagueId));
  if (!r) throw new Error(`league ${leagueId} has no draft room`);
  return r;
}

export async function playerBySourceId(db: Db, sourceId: string) {
  const [p] = await db.select().from(player).where(eq(player.sourcePlayerId, sourceId));
  if (!p) throw new Error(`no player with source id ${sourceId}`);
  return p;
}

export function selectProvider(env: NodeJS.ProcessEnv): StatsProvider {
  return statsProviderFromEnv(env);
}

// ---------------------------------------------------------------------------
// Name matching helpers for ingest:rankings
// ---------------------------------------------------------------------------

/**
 * Remove common diacritics so "Oyarzabal" matches "Oyarzabal".
 * Also handles chars that do not decompose under NFD (Ø, ø, ı, Æ, æ, Ł, ł,
 * Đ, đ, ß, Þ/þ, ð) — common in Scandinavian, Turkish, and Slavic names.
 */
const DIACRITIC_MAP: Record<string, string> = {
  "Ø": "O", "ø": "o",
  "Æ": "Ae", "æ": "ae",
  "Ł": "L", "ł": "l",
  "Đ": "D", "đ": "d",
  "ı": "i", "İ": "I",
  "ß": "ss",
  "Þ": "Th", "þ": "th",
  "ð": "d", "Ð": "D",
};
export function stripDiacritics(s: string): string {
  const substituted = [...s].map((c) => DIACRITIC_MAP[c] ?? c).join("");
    return substituted.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

/** Last word of a name — "Kylian Mbappe" → "mbappe". */
export function lastName(s: string): string {
  const parts = s.toLowerCase().trim().split(/\s+/);
  return parts[parts.length - 1] ?? "";
}

export function nameScore(a: string, b: string): number {
  const na = stripDiacritics(a).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const nb = stripDiacritics(b).toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const wa = new Set(na.split(" ").filter((w) => w.length > 1));
  const wb = nb.split(" ").filter((w) => w.length > 1);
  const overlap = wb.filter((w) => wa.has(w)).length;
  const total = Math.max(wa.size, wb.length);
  return total > 0 ? overlap / total : 0;
}

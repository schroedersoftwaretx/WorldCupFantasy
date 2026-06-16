/**
 * Per-league feature flags (Phase 0).
 *
 * A typed, league-scoped toggle store so commissioners opt into the features
 * later phases add. A flag is OFF unless a `league_feature_flag` row turns it
 * on, so a plain best-ball league is unchanged by default. Always read flags
 * through this helper - never check the raw column in a component (PLAN.md s5).
 *
 * Pure service: takes a Db (or DbTx) and plain inputs; no HTTP/auth/env here.
 */
import { and, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { leagueFeatureFlag } from "../db/schema.js";

/** The flags later phases gate on. Add new keys here as phases land. */
export const FLAGS = [
  "stats_hub",
  "chat",
  "head_to_head",
  "bracket",
  "survivor",
  "chips",
  "awards",
] as const;

export type FeatureFlag = (typeof FLAGS)[number];

/** Default enablement for a league with no rows. Everything off. */
export const DEFAULT_FLAGS: Readonly<Record<FeatureFlag, boolean>> = {
  stats_hub: false,
  chat: false,
  head_to_head: false,
  bracket: false,
  survivor: false,
  chips: false,
  awards: false,
};

export type FlagMap = Record<FeatureFlag, boolean>;

export interface FlagState {
  enabled: boolean;
  config: unknown | null;
}

export type FlagStateMap = Record<FeatureFlag, FlagState>;

/** True if `value` is a known flag key. */
export function isFeatureFlag(value: string): value is FeatureFlag {
  return (FLAGS as readonly string[]).includes(value);
}

/**
 * The boolean enablement of every flag for a league: defaults merged with any
 * rows that override them. Rows for keys no longer in FLAGS are ignored.
 */
export async function getFlags(
  db: Db | DbTx,
  leagueId: number,
): Promise<FlagMap> {
  const rows = await db
    .select()
    .from(leagueFeatureFlag)
    .where(eq(leagueFeatureFlag.leagueId, leagueId));
  const out: FlagMap = { ...DEFAULT_FLAGS };
  for (const r of rows) {
    if (isFeatureFlag(r.flag)) out[r.flag] = r.enabled;
  }
  return out;
}

/** Like getFlags but also returns each flag's stored config (null if none). */
export async function getFlagStates(
  db: Db | DbTx,
  leagueId: number,
): Promise<FlagStateMap> {
  const rows = await db
    .select()
    .from(leagueFeatureFlag)
    .where(eq(leagueFeatureFlag.leagueId, leagueId));
  const out = {} as FlagStateMap;
  for (const f of FLAGS) out[f] = { enabled: DEFAULT_FLAGS[f], config: null };
  for (const r of rows) {
    if (isFeatureFlag(r.flag)) {
      out[r.flag] = { enabled: r.enabled, config: r.config ?? null };
    }
  }
  return out;
}

/** Whether one flag is on for a league (defaults to OFF when unset). */
export async function isFlagEnabled(
  db: Db | DbTx,
  leagueId: number,
  flag: FeatureFlag,
): Promise<boolean> {
  const [row] = await db
    .select()
    .from(leagueFeatureFlag)
    .where(
      and(
        eq(leagueFeatureFlag.leagueId, leagueId),
        eq(leagueFeatureFlag.flag, flag),
      ),
    );
  return row?.enabled ?? DEFAULT_FLAGS[flag];
}

export interface SetFlagInput {
  enabled: boolean;
  /** Optional per-feature settings; stored as jsonb. */
  config?: unknown;
}

/**
 * Upsert one flag for a league. Idempotent on the (league_id, flag) PK:
 * calling twice with the same input leaves the same single row.
 */
export async function setFlag(
  db: Db | DbTx,
  leagueId: number,
  flag: FeatureFlag,
  input: SetFlagInput,
): Promise<void> {
  const config = input.config === undefined ? null : input.config;
  await db
    .insert(leagueFeatureFlag)
    .values({ leagueId, flag, enabled: input.enabled, config, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [leagueFeatureFlag.leagueId, leagueFeatureFlag.flag],
      set: { enabled: input.enabled, config, updatedAt: new Date() },
    });
}

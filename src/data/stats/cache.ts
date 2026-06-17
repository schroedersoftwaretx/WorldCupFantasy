/**
 * Optional in-process memo cache for the heavier Stats Hub reads (Phase 1.4).
 *
 * Follows the derived-not-stored principle: nothing is persisted. We simply
 * memoize a computed payload under a key that INCLUDES the latest
 * `score_entry.computedAt` for the ruleset, so the cache self-invalidates the
 * moment scores are recomputed (a new computedAt -> a new key -> a fresh
 * compute) without any explicit eviction. A tiny LRU-ish cap stops unbounded
 * growth across many stages/keys.
 *
 * This is opt-in: the pure services in this folder never touch it. Route
 * handlers may wrap a call in `memoizeByComputedAt` when a surface is measured
 * to be slow; correctness is identical with or without it.
 */
import { desc, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import { scoreEntry } from "../db/schema.js";

/** Latest score_entry.computedAt for a ruleset, as epoch ms; 0 when none. */
export async function latestComputedAt(
  db: Db | DbTx,
  rulesetVersion: string,
): Promise<number> {
  const [row] = await db
    .select({ computedAt: scoreEntry.computedAt })
    .from(scoreEntry)
    .where(eq(scoreEntry.rulesetVersion, rulesetVersion))
    .orderBy(desc(scoreEntry.computedAt))
    .limit(1);
  return row?.computedAt ? row.computedAt.getTime() : 0;
}

const MAX_ENTRIES = 64;
const store = new Map<string, unknown>();

/**
 * Memoize `compute()` under `${tag}:${rulesetVersion}:${latestComputedAt}`.
 * On a hit returns the cached value; on a miss computes, stores, and returns.
 */
export async function memoizeByComputedAt<T>(
  db: Db | DbTx,
  tag: string,
  rulesetVersion: string,
  compute: () => Promise<T>,
): Promise<T> {
  const stamp = await latestComputedAt(db, rulesetVersion);
  const key = `${tag}:${rulesetVersion}:${stamp}`;
  if (store.has(key)) return store.get(key) as T;
  const value = await compute();
  // Evict oldest insertion if over the cap (Map preserves insertion order).
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, value);
  return value;
}

/** Clear the memo cache (test hook). */
export function clearStatsCache(): void {
  store.clear();
}

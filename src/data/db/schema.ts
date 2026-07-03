/**
 * World Cup Fantasy - database schema (barrel).
 *
 * The schema is split by domain under ./schema/. This file re-exports every
 * symbol so existing imports of "db/schema" keep working unchanged:
 *   - enums.ts         all pgEnum declarations + their value-type aliases
 *   - football.ts      national_team, player, fixture, stat_line, score_entry
 *   - competition.ts   competition, scoring_period
 *   - leagues.ts       manager, league, league_membership, league_invite,
 *                      fantasy_team, roster_slot
 *   - draft.ts         draft_room, draft_order, draft_pick, draft_notification,
 *                      draft_queue
 *   - odds.ts          match_odds, projected_score_entry, stage_odds
 *   - notifications.ts standings_snapshot, notification, league_feature_flag,
 *                      notification_preference
 *
 * Invariants worth remembering:
 *   - stat_line is the immutable SOURCE OF TRUTH; only the ingestion path
 *     writes it. score_entry is fully recomputable from it.
 *   - A real player may be drafted at most once per league: roster_slot has
 *     a unique (league_id, player_id).
 *   - A manager has exactly one fantasy_team per league.
 *   - A league has at most one draft_room.
 */

export * from "./schema/enums.js";
export * from "./schema/football.js";
export * from "./schema/competition.js";
export * from "./schema/leagues.js";
export * from "./schema/draft.js";
export * from "./schema/odds.js";
export * from "./schema/notifications.js";
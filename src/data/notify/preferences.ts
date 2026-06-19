/**
 * Per-manager notification preferences (Phase 8).
 *
 * Account-level (not league-scoped) on/off switches per notification CATEGORY
 * per CHANNEL. The model is opt-OUT: with no stored row a channel is enabled,
 * so a manager who never visits settings keeps the default behaviour. Disabling
 * a (category, channel) suppresses that channel when `enqueue` is asked to send
 * a notification of that category.
 *
 * Categories are exactly the notification `type`s that exist today — the draft
 * lifecycle events. No categories are invented here for unbuilt features.
 *
 * Pure service: takes a `Db`/`DbTx` first and plain inputs, never reads
 * env/config. The channel-filtering decision is split into pure helpers so it
 * is unit-testable without a database.
 */
import { and, eq } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  notificationPreference,
  type NotificationChannel,
} from "../db/schema.js";

/**
 * The notification categories a manager can toggle. These mirror the draft
 * notification `type`s that the app emits today; do NOT add categories for
 * features that are not built (goal alerts, chips, survivor, chat, ...).
 */
export const NOTIFICATION_CATEGORIES = [
  "DRAFT_STARTED",
  "ON_THE_CLOCK",
  "PICK_MADE",
  "AUTOPICK_MADE",
  "DRAFT_COMPLETE",
] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/** Human-readable label + helper text per category, for the settings UI. */
export const CATEGORY_LABELS: Record<
  NotificationCategory,
  { label: string; description: string }
> = {
  DRAFT_STARTED: {
    label: "Draft started",
    description: "When a league's draft begins.",
  },
  ON_THE_CLOCK: {
    label: "You're on the clock",
    description: "When it becomes your pick in a draft.",
  },
  PICK_MADE: {
    label: "Picks made",
    description: "When a pick is made in a draft you're in.",
  },
  AUTOPICK_MADE: {
    label: "Autopicks",
    description: "When the timer auto-picks for a team.",
  },
  DRAFT_COMPLETE: {
    label: "Draft complete",
    description: "When a league's draft finishes.",
  },
};

/** The channels a preference can apply to. */
export const PREFERENCE_CHANNELS: readonly NotificationChannel[] = [
  "IN_APP",
  "EMAIL",
];

export function isNotificationCategory(s: string): s is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(s);
}

/** Build the lookup key for a disabled (category, channel) pair. */
function disabledKey(category: string, channel: NotificationChannel): string {
  return `${category}::${channel}`;
}

/**
 * Build the set of explicitly-DISABLED (category, channel) pairs from stored
 * rows. Only `enabled === false` rows matter; everything else is the enabled
 * default. Pure — exported for unit tests.
 */
export function disabledSetFromRows(
  rows: ReadonlyArray<{
    category: string;
    channel: NotificationChannel;
    enabled: boolean;
  }>,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.enabled) out.add(disabledKey(r.category, r.channel));
  }
  return out;
}

/**
 * Filter a requested channel list down to the ones the manager still allows for
 * a notification `type`. Unknown types (not a managed category) are never
 * filtered — only the known draft categories honour preferences. Pure —
 * exported for unit tests.
 */
export function applyPreferences(
  type: string,
  requested: readonly NotificationChannel[],
  disabled: ReadonlySet<string>,
): NotificationChannel[] {
  if (!isNotificationCategory(type)) return [...requested];
  return requested.filter((c) => !disabled.has(disabledKey(type, c)));
}

/**
 * The channels actually permitted for a manager + notification type, given the
 * requested set. Loads the manager's stored preferences and applies them. A
 * no-op (returns `requested` unchanged) for types that are not managed
 * categories, so it never blocks an unrelated future notification kind.
 */
export async function allowedChannels(
  db: Db | DbTx,
  managerId: number,
  type: string,
  requested: readonly NotificationChannel[],
): Promise<NotificationChannel[]> {
  if (!isNotificationCategory(type)) return [...requested];
  const rows = await db
    .select({
      category: notificationPreference.category,
      channel: notificationPreference.channel,
      enabled: notificationPreference.enabled,
    })
    .from(notificationPreference)
    .where(eq(notificationPreference.managerId, managerId));
  return applyPreferences(type, requested, disabledSetFromRows(rows));
}

/** A manager's full preference matrix: enabled flag per category per channel. */
export type PreferenceMatrix = Record<
  NotificationCategory,
  Record<NotificationChannel, boolean>
>;

/**
 * The manager's full preference matrix, with the enabled-by-default applied for
 * any (category, channel) that has no stored row. Drives the settings UI.
 */
export async function getPreferences(
  db: Db | DbTx,
  managerId: number,
): Promise<PreferenceMatrix> {
  const rows = await db
    .select({
      category: notificationPreference.category,
      channel: notificationPreference.channel,
      enabled: notificationPreference.enabled,
    })
    .from(notificationPreference)
    .where(eq(notificationPreference.managerId, managerId));

  const stored = new Map<string, boolean>();
  for (const r of rows) stored.set(disabledKey(r.category, r.channel), r.enabled);

  const matrix = {} as PreferenceMatrix;
  for (const category of NOTIFICATION_CATEGORIES) {
    matrix[category] = {} as Record<NotificationChannel, boolean>;
    for (const channel of PREFERENCE_CHANNELS) {
      matrix[category][channel] =
        stored.get(disabledKey(category, channel)) ?? true;
    }
  }
  return matrix;
}

/**
 * Set (upsert) one (category, channel) toggle for a manager. Returns the new
 * full matrix so a caller can re-render. Idempotent.
 */
export async function setPreference(
  db: Db | DbTx,
  managerId: number,
  category: NotificationCategory,
  channel: NotificationChannel,
  enabled: boolean,
): Promise<PreferenceMatrix> {
  await db
    .insert(notificationPreference)
    .values({ managerId, category, channel, enabled, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [
        notificationPreference.managerId,
        notificationPreference.category,
        notificationPreference.channel,
      ],
      set: { enabled, updatedAt: new Date() },
    });
  return getPreferences(db, managerId);
}

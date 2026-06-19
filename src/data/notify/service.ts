/**
 * App-wide notification hub service (Phase 0).
 *
 * Generalizes the draft's durable-queue pattern (see `draft_notification`) into
 * something any feature can write to. Every notification is persisted to the
 * `notification` table BEFORE any out-of-band delivery, so nothing is lost if
 * delivery is deferred or fails.
 *
 *   IN_APP  surfaces in the bell/inbox immediately (written status SENT) and
 *           becomes READ when opened.
 *   EMAIL   is written PENDING and delivered later via deliverPending() through
 *           a shared EmailTransport, then marked SENT / FAILED.
 *
 * Pure service: HTTP and auth live in the route adapters. This module only
 * takes a Db (or DbTx) and plain inputs, and never reads env/config.
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";

import type { Db, DbTx } from "../db/client.js";
import {
  manager,
  notification,
  type NotificationChannel,
  type NotificationRow,
} from "../db/schema.js";
import { allowedChannels } from "./preferences.js";
import type { EmailMessage, EmailTransport } from "./transport.js";

export interface EnqueueInput {
  managerId: number;
  /** Extensible per-phase kind, e.g. "DRAFT_STARTED", "CHAT_MENTION". */
  type: string;
  title: string;
  body: string;
  /** League this concerns, when league-scoped. */
  leagueId?: number | null;
  /** In-app deep link, e.g. "/leagues/3/draft". */
  link?: string | null;
  /** Channels to deliver on. Defaults to ["IN_APP"]. */
  channels?: NotificationChannel[];
  /** When set, suppresses repeats per (manager, channel). */
  dedupeKey?: string | null;
}

/**
 * Enqueue a notification on one or more channels for one manager. Idempotent
 * when `dedupeKey` is set: a channel that already has a row with the same
 * (managerId, dedupeKey) is skipped, so re-enqueuing the same logical event is
 * a no-op. Returns the rows actually inserted (empty when all were suppressed).
 */
export async function enqueue(
  db: Db | DbTx,
  input: EnqueueInput,
): Promise<NotificationRow[]> {
  const requested = input.channels ?? ["IN_APP"];
  const dedupeKey = input.dedupeKey ?? null;
  const leagueId = input.leagueId ?? null;
  const link = input.link ?? null;

  // De-duplicate the requested channel list itself.
  const deduped = requested.filter((c, i) => requested.indexOf(c) === i);

  // Respect the manager's per-category notification preferences: a channel the
  // manager has opted out of for this notification type is dropped before any
  // row is written, so an opted-out category produces no notification at all.
  // Unmanaged types pass through unchanged.
  const channels = await allowedChannels(db, input.managerId, input.type, deduped);
  if (channels.length === 0) return [];

  // Which channels already exist for this dedupe key (so we skip them)?
  let existing = new Set<NotificationChannel>();
  if (dedupeKey !== null) {
    const rows = await db
      .select({ channel: notification.channel })
      .from(notification)
      .where(
        and(
          eq(notification.managerId, input.managerId),
          eq(notification.dedupeKey, dedupeKey),
        ),
      );
    existing = new Set(rows.map((r) => r.channel));
  }

  const values = channels
    .filter((c) => !existing.has(c))
    .map((channel) => ({
      managerId: input.managerId,
      leagueId,
      type: input.type,
      channel,
      // IN_APP is "delivered" the moment it is written; EMAIL awaits transport.
      status: (channel === "IN_APP" ? "SENT" : "PENDING") as
        | "SENT"
        | "PENDING",
      title: input.title,
      body: input.body,
      link,
      dedupeKey,
      sentAt: channel === "IN_APP" ? new Date() : null,
    }));

  if (values.length === 0) return [];
  return db.insert(notification).values(values).returning();
}

/**
 * Mark one IN_APP notification READ for a manager. Scoped to the manager so one
 * cannot read another's notifications. Returns true if a row was updated.
 */
export async function markRead(
  db: Db | DbTx,
  managerId: number,
  notificationId: number,
): Promise<boolean> {
  const updated = await db
    .update(notification)
    .set({ status: "READ", readAt: new Date() })
    .where(
      and(
        eq(notification.id, notificationId),
        eq(notification.managerId, managerId),
      ),
    )
    .returning({ id: notification.id });
  return updated.length > 0;
}

export interface ListOptions {
  unreadOnly?: boolean;
  limit?: number;
}

export interface ManagerInbox {
  notifications: NotificationRow[];
  /** Count of IN_APP notifications not yet READ. */
  unreadCount: number;
}

/**
 * The IN_APP inbox for a manager: notifications newest-first plus the unread
 * count (status <> READ). EMAIL-only rows never appear here.
 */
export async function listForManager(
  db: Db | DbTx,
  managerId: number,
  options: ListOptions = {},
): Promise<ManagerInbox> {
  const limit = options.limit ?? 50;
  const inApp = and(
    eq(notification.managerId, managerId),
    eq(notification.channel, "IN_APP"),
  );
  const unread = and(inApp, ne(notification.status, "READ"));

  const rows = await db
    .select()
    .from(notification)
    .where(options.unreadOnly ? unread : inApp)
    .orderBy(desc(notification.createdAt), desc(notification.id))
    .limit(limit);

  const unreadRows = await db
    .select({ id: notification.id })
    .from(notification)
    .where(unread);

  return { notifications: rows, unreadCount: unreadRows.length };
}

export interface DeliverPendingOptions {
  /** Only deliver this manager's pending email. */
  managerId?: number;
  /** Public base URL (no trailing slash) to make relative links absolute. */
  baseUrl?: string;
}

export interface DeliverResult {
  delivered: number;
  failed: number;
}

/**
 * Deliver every not-yet-sent EMAIL notification (PENDING or a prior FAILED) via
 * the transport, marking each SENT / FAILED. A no-op when no transport is
 * supplied - the rows stay durable for a later attempt. Idempotent: SENT rows
 * are never re-sent.
 */
export async function deliverPending(
  db: Db | DbTx,
  transport: EmailTransport | undefined,
  options: DeliverPendingOptions = {},
): Promise<DeliverResult> {
  if (!transport) return { delivered: 0, failed: 0 };

  const conds = [
    eq(notification.channel, "EMAIL"),
    inArray(notification.status, ["PENDING", "FAILED"]),
  ];
  if (options.managerId !== undefined) {
    conds.push(eq(notification.managerId, options.managerId));
  }
  const pending = await db
    .select()
    .from(notification)
    .where(and(...conds));

  let delivered = 0;
  let failed = 0;
  for (const n of pending) {
    const [mgr] = await db
      .select({ email: manager.email, displayName: manager.displayName })
      .from(manager)
      .where(eq(manager.id, n.managerId));
    if (!mgr) continue;

    const result = await transport.send({
      ...renderEmail(n, mgr.displayName, options.baseUrl),
      to: mgr.email,
    });
    if (result.delivered) {
      await db
        .update(notification)
        .set({ status: "SENT", sentAt: new Date() })
        .where(eq(notification.id, n.id));
      delivered += 1;
    } else {
      await db
        .update(notification)
        .set({ status: "FAILED" })
        .where(eq(notification.id, n.id));
      failed += 1;
    }
  }
  return { delivered, failed };
}

/** Build the email body for a notification row. Exported for tests. */
export function renderEmail(
  n: Pick<NotificationRow, "title" | "body" | "link">,
  toName: string,
  baseUrl?: string,
): EmailMessage {
  const absoluteLink = resolveLink(n.link, baseUrl);
  const text = [
    `Hi ${toName},`,
    "",
    n.body,
    ...(absoluteLink ? ["", `Open: ${absoluteLink}`] : []),
  ].join("\n");
  const button = absoluteLink
    ? `<p style="margin:24px 0 0;"><a href="${escapeHtml(absoluteLink)}" ` +
      `style="display:inline-block;background:#1f6feb;color:#fff;` +
      `text-decoration:none;font-weight:600;padding:10px 18px;` +
      `border-radius:6px;">Open</a></p>`
    : "";
  const html =
    `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,` +
    `sans-serif;max-width:480px;color:#1a1a1a;line-height:1.5;">` +
    `<h2 style="font-size:18px;margin:0 0 12px;">${escapeHtml(n.title)}</h2>` +
    `<p style="margin:0;">${escapeHtml(n.body)}</p>${button}</div>`;
  return { to: "", subject: n.title, html, text };
}

/** Turn a relative link into an absolute URL when a base URL is known. */
function resolveLink(
  link: string | null,
  baseUrl: string | undefined,
): string | null {
  if (!link) return null;
  if (/^https?:\/\//i.test(link)) return link;
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, "");
  return link.startsWith("/") ? `${base}${link}` : `${base}/${link}`;
}

/** Minimal HTML escaping for the small set of values we interpolate. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

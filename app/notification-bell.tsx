/**
 * NotificationBell - the nav inbox surface (Phase 0).
 *
 * Polls GET /api/notifications for the signed-in manager's in-app inbox, shows
 * the unread count as a badge, and opens a dropdown of recent items. Opening an
 * item marks it read (POST /api/notifications/[id]/read) and follows its link.
 * Read through the same envelope every API route returns.
 */
"use client";

import { useCallback, useEffect, useState } from "react";

interface InboxItem {
  id: number;
  type: string;
  title: string;
  body: string;
  link: string | null;
  status: string;
  createdAt: string;
}

interface InboxResponse {
  data?: { notifications: InboxItem[]; unreadCount: number };
  error?: { message?: string };
}

const POLL_MS = 30_000;

export default function NotificationBell() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/notifications?limit=20", {
        cache: "no-store",
      });
      if (!res.ok) return;
      const body = (await res.json()) as InboxResponse;
      if (body.data) {
        setItems(body.data.notifications);
        setUnread(body.data.unreadCount);
      }
    } catch {
      // Network hiccup: keep the last known state, try again next tick.
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  async function handleOpenItem(item: InboxItem): Promise<void> {
    if (item.status !== "READ") {
      try {
        await fetch(`/api/notifications/${item.id}/read`, { method: "POST" });
      } catch {
        /* non-fatal: navigation still proceeds */
      }
    }
    if (item.link) {
      window.location.assign(item.link);
    } else {
      void load();
      setOpen(false);
    }
  }

  return (
    <span className="notif-bell">
      <button
        type="button"
        className="btn-link notif-bell-btn"
        aria-label={`Notifications (${unread} unread)`}
        onClick={() => {
          setOpen((v) => !v);
          if (!open) void load();
        }}
      >
        Inbox
        {unread > 0 ? <span className="notif-badge">{unread}</span> : null}
      </button>
      {open ? (
        <div className="notif-dropdown">
          {items.length === 0 ? (
            <p className="notif-empty">No notifications.</p>
          ) : (
            <ul className="notif-list">
              {items.map((item) => (
                <li
                  key={item.id}
                  className={
                    item.status === "READ" ? "notif-item read" : "notif-item"
                  }
                >
                  <button
                    type="button"
                    className="notif-item-btn"
                    onClick={() => void handleOpenItem(item)}
                  >
                    <span className="notif-item-title">{item.title}</span>
                    <span className="notif-item-body">{item.body}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </span>
  );
}

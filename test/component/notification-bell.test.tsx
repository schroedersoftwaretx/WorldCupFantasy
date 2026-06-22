// @vitest-environment jsdom
/**
 * NotificationBell — nav inbox: polls the inbox, shows an unread badge, opens a
 * dropdown, and marks an item read when opened.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import NotificationBell from "../../app/notification-bell";

const inbox = {
  notifications: [
    { id: 11, type: "draft", title: "You're on the clock", body: "Pick now", link: null, status: "UNREAD", createdAt: "2026-06-20T00:00:00Z" },
    { id: 12, type: "league", title: "League full", body: "All joined", link: null, status: "READ", createdAt: "2026-06-19T00:00:00Z" },
  ],
  unreadCount: 1,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (String(url).startsWith("/api/notifications?")) {
        return { ok: true, json: async () => ({ data: inbox }) };
      }
      return { ok: true, json: async () => ({ data: {} }) };
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("NotificationBell", () => {
  it("polls the inbox and shows the unread badge", async () => {
    render(<NotificationBell />);
    // aria-label reflects the unread count once the poll resolves.
    expect(
      await screen.findByRole("button", { name: "Notifications (1 unread)" }),
    ).toBeInTheDocument();
  });

  it("opens a dropdown listing the notifications", async () => {
    const user = userEvent.setup();
    render(<NotificationBell />);
    await screen.findByRole("button", { name: "Notifications (1 unread)" });

    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    expect(screen.getByText("You're on the clock")).toBeInTheDocument();
    expect(screen.getByText("League full")).toBeInTheDocument();
  });

  it("marks an unread item read when opened", async () => {
    const user = userEvent.setup();
    render(<NotificationBell />);
    await screen.findByRole("button", { name: "Notifications (1 unread)" });
    await user.click(screen.getByRole("button", { name: /Notifications/ }));

    await user.click(screen.getByText("You're on the clock"));
    expect(fetch).toHaveBeenCalledWith("/api/notifications/11/read", { method: "POST" });
  });
});

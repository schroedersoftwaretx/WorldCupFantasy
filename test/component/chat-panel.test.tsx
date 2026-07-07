// @vitest-environment jsdom
/**
 * ChatPanel — posting, reactions, image-URL embeds and owner moderation.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import "./setup";

import ChatPanel, {
  type ChatMessageView,
} from "../../app/leagues/[leagueId]/chat/chat-panel";

class FakeEventSource {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  close = vi.fn();
  constructor(public url: string) {}
}

beforeEach(() => {
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

function msg(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  return {
    id: 1,
    managerId: 42,
    authorName: "Olive Owner",
    body: "hello league",
    deleted: false,
    createdAt: "2026-06-01T12:00:00.000Z",
    editedAt: null,
    reactions: [],
    ...overrides,
  };
}

describe("ChatPanel", () => {
  it("renders messages and inlines image URLs", () => {
    render(
      <ChatPanel
        leagueId={1}
        viewerManagerId={7}
        isOwner={false}
        initial={[
          msg(),
          msg({ id: 2, body: "look https://x.test/goal.gif wow" }),
        ]}
      />,
    );
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "embedded" })).toHaveAttribute(
      "src",
      "https://x.test/goal.gif",
    );
  });

  it("POSTs a new message", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);

    render(
      <ChatPanel leagueId={9} viewerManagerId={7} isOwner={false} initial={[]} />,
    );
    await user.type(screen.getByRole("textbox", { name: /New message/ }), "gooooal");
    await user.click(screen.getByRole("button", { name: /Send/ }));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/leagues/9/chat");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ body: "gooooal" });
    expect(await screen.findByText(/gooooal/)).toBeInTheDocument();
  });

  it("toggles a reaction", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: { reacted: true } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);

    render(
      <ChatPanel
        leagueId={9}
        viewerManagerId={7}
        isOwner={false}
        initial={[
          msg({
            reactions: [{ emoji: "\u{1F44D}", count: 2, managerIds: [42] }],
          }),
        ]}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /toggle reaction/ }),
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/leagues/9/chat/1/reactions");
    expect(JSON.parse(String(init.body))).toEqual({ emoji: "\u{1F44D}" });
  });

  it("shows moderation delete for the owner but not edit", () => {
    render(
      <ChatPanel
        leagueId={1}
        viewerManagerId={7}
        isOwner={true}
        initial={[msg()]} // authored by manager 42, viewer is 7
      />,
    );
    expect(screen.getByRole("button", { name: /Delete/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Edit$/ })).not.toBeInTheDocument();
  });
});

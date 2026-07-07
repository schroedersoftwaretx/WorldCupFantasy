/**
 * ChatPanel - live league chat.
 *
 * Subscribes to the SSE stream (poll+diff on the server; EventSource here),
 * renders newest-last, posts via POST, toggles emoji reactions, lets
 * authors edit/delete their own messages (the owner can delete any), and
 * inlines image/GIF URLs pasted into a message.
 */
"use client";

import { useEffect, useRef, useState } from "react";

export interface ChatReactionView {
  emoji: string;
  count: number;
  managerIds: number[];
}

export interface ChatMessageView {
  id: number;
  managerId: number;
  authorName: string;
  body: string;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
  reactions: ChatReactionView[];
}

interface ChatPanelProps {
  leagueId: number;
  viewerManagerId: number;
  isOwner: boolean;
  initial: ChatMessageView[];
}

const QUICK_EMOJI = ["\u{1F44D}", "\u{1F602}", "\u{1F525}", "\u{1F62D}"];
const IMAGE_URL = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i;

/** Render a message body, inlining bare image/GIF URLs. */
function Body({ body }: { body: string }) {
  const parts = body.split(/(\s+)/);
  return (
    <>
      {parts.map((part, i) =>
        IMAGE_URL.test(part) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={part} alt="embedded" className="chat-embed" />
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

export default function ChatPanel({
  leagueId,
  viewerManagerId,
  isOwner,
  initial,
}: ChatPanelProps) {
  const [messages, setMessages] = useState<ChatMessageView[]>(initial);
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const es = new EventSource(`/api/leagues/${leagueId}/chat/stream`);
    es.onmessage = (ev) => {
      try {
        setMessages(JSON.parse(ev.data as string) as ChatMessageView[]);
      } catch {
        /* ignore malformed frames */
      }
    };
    return () => es.close();
  }, [leagueId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);

  async function api(path: string, method: string, body?: unknown): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { "Content-Type": "application/json" };
        init.body = JSON.stringify(body);
      }
      const res = await fetch(path, init);
      const parsed = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) throw new Error(parsed.error?.message ?? "request failed");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "request failed");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(): Promise<void> {
    const body = draft.trim();
    if (!body) return;
    if (await api(`/api/leagues/${leagueId}/chat`, "POST", { body })) {
      setDraft("");
      // Optimistic append; the stream reconciles shortly after.
      setMessages((prev) => [
        {
          id: -Date.now(),
          managerId: viewerManagerId,
          authorName: "You",
          body,
          deleted: false,
          createdAt: new Date().toISOString(),
          editedAt: null,
          reactions: [],
        },
        ...prev,
      ]);
    }
  }

  async function saveEdit(id: number): Promise<void> {
    const body = editDraft.trim();
    if (!body) return;
    if (await api(`/api/leagues/${leagueId}/chat/${id}`, "PATCH", { body })) {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, body, editedAt: new Date().toISOString() } : m)),
      );
      setEditingId(null);
    }
  }

  async function remove(id: number): Promise<void> {
    if (await api(`/api/leagues/${leagueId}/chat/${id}`, "DELETE")) {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, body: "[deleted]", deleted: true } : m)),
      );
    }
  }

  async function react(id: number, emoji: string): Promise<void> {
    await api(`/api/leagues/${leagueId}/chat/${id}/reactions`, "POST", { emoji });
  }

  // The API returns newest-first; render oldest-first.
  const ordered = [...messages].sort((a, b) => a.id - b.id);

  return (
    <div className="chat-panel">
      <div className="chat-scroll" role="log" aria-label="League chat messages">
        {ordered.length === 0 ? (
          <p className="subtitle">No messages yet - say hi!</p>
        ) : null}
        {ordered.map((m) => (
          <div key={m.id} className="chat-message">
            <div>
              <strong>{m.authorName}</strong>{" "}
              <span className="subtitle">
                {new Date(m.createdAt).toLocaleString()}
                {m.editedAt && !m.deleted ? " (edited)" : ""}
              </span>
            </div>
            {editingId === m.id ? (
              <p>
                <input
                  value={editDraft}
                  maxLength={2000}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveEdit(m.id);
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  aria-label="Edit message"
                />{" "}
                <button type="button" className="btn-sm" disabled={busy} onClick={() => void saveEdit(m.id)}>
                  Save
                </button>{" "}
                <button type="button" className="btn-link" onClick={() => setEditingId(null)}>
                  Cancel
                </button>
              </p>
            ) : (
              <p className={m.deleted ? "subtitle" : undefined}>
                <Body body={m.body} />
              </p>
            )}
            {!m.deleted ? (
              <div className="chat-actions">
                {m.reactions.map((r) => (
                  <button
                    key={r.emoji}
                    type="button"
                    className={`btn-sm chat-reaction${r.managerIds.includes(viewerManagerId) ? " active" : ""}`}
                    onClick={() => void react(m.id, r.emoji)}
                    aria-label={`${r.emoji} ${r.count}, toggle reaction`}
                  >
                    {r.emoji} {r.count}
                  </button>
                ))}
                {QUICK_EMOJI.filter(
                  (e) => !m.reactions.some((r) => r.emoji === e),
                ).map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="btn-link chat-reaction"
                    onClick={() => void react(m.id, e)}
                    aria-label={`React ${e}`}
                  >
                    {e}
                  </button>
                ))}
                {m.managerId === viewerManagerId && m.id > 0 ? (
                  <button
                    type="button"
                    className="btn-link"
                    onClick={() => {
                      setEditingId(m.id);
                      setEditDraft(m.body);
                    }}
                  >
                    Edit
                  </button>
                ) : null}
                {(m.managerId === viewerManagerId || isOwner) && m.id > 0 ? (
                  <button type="button" className="btn-link" onClick={() => void remove(m.id)}>
                    Delete
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <p>
        <input
          className="chat-input"
          value={draft}
          maxLength={2000}
          placeholder="Message your league… (paste an image URL to embed)"
          aria-label="New message"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void send();
          }}
        />{" "}
        <button
          type="button"
          className="btn-sm"
          disabled={busy || !draft.trim()}
          onClick={() => void send()}
        >
          Send
        </button>
      </p>
      {error ? <span className="error">{error}</span> : null}
      <p className="subtitle">
        Mute chat notifications in{" "}
        <a href="/account/notifications">notification settings</a>.
      </p>
    </div>
  );
}

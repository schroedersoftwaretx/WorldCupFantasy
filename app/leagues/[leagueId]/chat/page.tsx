/**
 * Chat page (Phase 3 subset UI) - live league chat behind the chat flag.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { getFlags } from "@/data/league/feature-flags";
import { listMessages, type ChatMessageView } from "@/data/social/chat";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import LeagueTabs from "../league-tabs";
import ChatPanel, { type ChatMessageView as ClientMessage } from "./chat-panel";

export const dynamic = "force-dynamic";

export default async function ChatPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number.parseInt(leagueId, 10);
  if (!Number.isInteger(id) || id <= 0) {
    return (
      <main className="container">
        <p className="error">Invalid league id: {leagueId}</p>
      </main>
    );
  }

  const db = getDb();
  const role = await getMembershipRole(db, id, user.manager.id);
  if (!role) {
    return (
      <main className="container">
        <p className="notice">League not found, or you are not a member.</p>
      </main>
    );
  }
  const isOwner = role === "OWNER";

  const flags = await getFlags(db, id);
  if (!flags.chat) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="chat" />
        <h1>Chat</h1>
        <p className="notice">
          Chat is not enabled for this league.
          {isOwner ? " Turn it on in Settings to get started." : ""}
        </p>
      </main>
    );
  }

  let initial: ChatMessageView[] = [];
  try {
    initial = await listMessages(db, { leagueId: id, managerId: user.manager.id });
  } catch {
    initial = [];
  }
  const clientInitial: ClientMessage[] = initial.map((m) => ({
    ...m,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt ? m.editedAt.toISOString() : null,
  }));

  return (
    <main className="container">
      <Link href={`/leagues/${id}`} className="back-link">
        &larr; League
      </Link>
      <LeagueTabs leagueId={id} isOwner={isOwner} current="chat" />
      <h1>League chat</h1>
      <ChatPanel
        leagueId={id}
        viewerManagerId={user.manager.id}
        isOwner={isOwner}
        initial={clientInitial}
      />
    </main>
  );
}

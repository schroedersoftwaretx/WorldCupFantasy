/**
 * Chat page (Phase 3 subset UI) - live league chat behind the chat flag.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { getFlags } from "@/data/league/feature-flags";
import { listActivity } from "@/data/social/activity";
import { listMessages, type ChatMessageView } from "@/data/social/chat";
import type { StageRecap } from "@/data/social/recap";
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

  let activity: Awaited<ReturnType<typeof listActivity>> = [];
  try {
    activity = await listActivity(db, id, 20);
  } catch {
    activity = [];
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
      {activity.length > 0 ? (
        <section>
          <h2>Activity</h2>
          <ul>
            {activity.map((e) => (
              <li key={e.id}>
                <ActivityLine type={e.type} payload={e.payload} />{" "}
                <span className="subtitle">
                  {e.createdAt.toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </main>
  );
}

/** Templated, deterministic copy per activity event type. */
function ActivityLine({ type, payload }: { type: string; payload: unknown }) {
  if (type === "CHIP_PLAYED") {
    const p = payload as { teamName?: string; chip?: string; periodLabel?: string };
    return (
      <span>
        <strong>{p.teamName ?? "A team"}</strong> played{" "}
        {String(p.chip ?? "a chip").replace(/_/g, " ").toLowerCase()} on{" "}
        {p.periodLabel ?? "a period"}
      </span>
    );
  }
  if (type === "H2H_SCHEDULE_GENERATED") {
    const p = payload as { matchups?: number; regenerated?: boolean };
    return (
      <span>
        Head-to-head schedule {p.regenerated ? "regenerated" : "generated"}
        {typeof p.matchups === "number" ? ` (${p.matchups} matchups)` : ""}
      </span>
    );
  }
  if (type === "STAGE_RECAP") {
    const r = payload as StageRecap;
    const leader = r.powerRankings[0];
    return (
      <span>
        <strong>{r.stage} recap</strong>
        {r.managerOfStage
          ? ` - Manager of the stage: ${r.managerOfStage.teamNames.join(" & ")} (${r.managerOfStage.points} pts)`
          : ""}
        {r.topHaul
          ? `; top haul ${r.topHaul.playerName} ${r.topHaul.points} pts (${r.topHaul.teamName})`
          : ""}
        {r.biggestBlowout
          ? `; biggest blowout ${r.biggestBlowout.winnerName} over ${r.biggestBlowout.loserName} by ${r.biggestBlowout.margin}`
          : ""}
        {leader ? `; power #1 ${leader.teamName}` : ""}
      </span>
    );
  }
  return <span>{type}</span>;
}

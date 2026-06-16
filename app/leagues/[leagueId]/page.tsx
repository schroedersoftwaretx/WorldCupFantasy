/**
 * League overview page.
 *
 * The home screen for one league: its managers, a link to standings, and -
 * for the owner - the invite panel. Auth-gated, and membership-gated (W3):
 * a signed-in user who is not a member sees a not-found message, never the
 * league's contents.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import type { LeagueDetail } from "@/web/api-types";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getDraftRoomRow } from "@/web/draft-view";
import { getLeagueDetail, getMembershipRole } from "@/web/queries";

import InvitePanel from "./invite-panel";
import LeagueTabs from "./league-tabs";
import RenameTeamForm from "./rename-team-form";

export const dynamic = "force-dynamic";

export default async function LeagueOverviewPage({
  params,
}: {
  params: Promise<{ leagueId: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { leagueId } = await params;
  const id = Number(leagueId);

  const back = (
    <Link href="/" className="back-link">
      &larr; Your leagues
    </Link>
  );

  if (!Number.isInteger(id) || id <= 0) {
    return (
      <>
        {back}
        <p className="error">Invalid league id: {leagueId}</p>
      </>
    );
  }

  let role: string | null = null;
  let detail: LeagueDetail | null = null;
  let draftComplete = false;
  let error: string | null = null;
  try {
    const db = getDb();
    role = await getMembershipRole(db, id, user.manager.id);
    if (role) {
      detail = await getLeagueDetail(db, id);
      const room = await getDraftRoomRow(db, id);
      draftComplete = room?.status === "COMPLETE";
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load the league";
  }

  if (error) {
    return (
      <>
        {back}
        <p className="error">Could not load the league: {error}</p>
      </>
    );
  }
  // Not a member -> do not confirm the league even exists.
  if (!role || !detail) {
    return (
      <>
        {back}
        <p className="notice">League not found, or you are not a member.</p>
      </>
    );
  }

  const isOwner = role === "OWNER";

  return (
    <>
      {back}
      <h1>
        {detail.name}
        <span className="tag">{detail.status}</span>
      </h1>
      <p className="subtitle">
        {detail.memberCount} of {detail.maxManagers} managers &middot;{" "}
        {detail.rosterSize}-player rosters &middot; you are{" "}
        {isOwner ? "the owner" : "a member"}.
      </p>

      <LeagueTabs leagueId={detail.id} isOwner={isOwner} />

      <h2>Managers</h2>
      <table>
        <thead>
          <tr>
            <th>Manager</th>
            <th>Team</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {detail.members.map((m) => (
            <tr key={m.managerId}>
              <td>{m.displayName}</td>
              <td>
                {m.managerId === user.manager.id ? (
                  <RenameTeamForm
                    leagueId={detail.id}
                    currentName={m.teamName ?? ""}
                  />
                ) : (
                  m.teamName ?? "-"
                )}
              </td>
              <td>{m.role}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="lead-link">
        <Link href={`/leagues/${detail.id}/draft`}>
          Go to the draft room &rarr;
        </Link>
      </p>
      {draftComplete ? (
        <p className="lead-link">
          <Link href={`/leagues/${detail.id}/draft/results`}>
            View draft results &rarr;
          </Link>
        </p>
      ) : null}
      <p className="lead-link">
        <Link href={`/leagues/${detail.id}/standings`}>
          View standings &rarr;
        </Link>
      </p>

      {isOwner ? <InvitePanel leagueId={detail.id} /> : null}
    </>
  );
}

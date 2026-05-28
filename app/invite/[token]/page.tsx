/**
 * Invite landing page: /invite/[token].
 *
 * The friend opens the link, signs in (middleware preserves the path via
 * ?next=), then joins. If they are already a member, or the invite is no
 * longer usable, the page explains that instead of offering a Join button.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import type { InviteLookup } from "@/web/api-types";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getInviteByToken, getMembershipRole } from "@/web/queries";

import JoinButton from "./join-button";

export const dynamic = "force-dynamic";

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { token } = await params;

  let invite: InviteLookup | null = null;
  let alreadyMember = false;
  let error: string | null = null;
  try {
    const db = getDb();
    invite = await getInviteByToken(db, token);
    if (invite) {
      const role = await getMembershipRole(
        db,
        invite.leagueId,
        user.manager.id,
      );
      alreadyMember = role !== null;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load the invite";
  }

  const home = (
    <p>
      <Link href="/" className="back-link">
        &larr; Your leagues
      </Link>
    </p>
  );

  if (error) {
    return (
      <div className="auth-card">
        <h1>Invite</h1>
        <p className="error">{error}</p>
        {home}
      </div>
    );
  }

  if (!invite) {
    return (
      <div className="auth-card">
        <h1>Invite not found</h1>
        <p className="subtitle">This invite link is not valid.</p>
        {home}
      </div>
    );
  }

  if (alreadyMember) {
    return (
      <div className="auth-card">
        <h1>{invite.leagueName}</h1>
        <p className="subtitle">You are already a member of this league.</p>
        <Link href={`/leagues/${invite.leagueId}`} className="btn">
          Go to league
        </Link>
      </div>
    );
  }

  const expired = new Date(invite.expiresAt).getTime() <= Date.now();
  const usable = invite.status === "PENDING" && !expired;

  if (!usable) {
    return (
      <div className="auth-card">
        <h1>{invite.leagueName}</h1>
        <p className="error">
          {expired
            ? "This invite link has expired."
            : "This invite link is no longer active."}
        </p>
        {home}
      </div>
    );
  }

  return (
    <div className="auth-card">
      <h1>Join {invite.leagueName}</h1>
      <p className="subtitle">
        You have been invited to join this league as{" "}
        {user.manager.displayName}.
      </p>
      <JoinButton token={invite.token} />
    </div>
  );
}

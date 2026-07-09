/**
 * Transactions page (Priority 5 UI) - free agency, waiver claims, and the
 * trade center, behind the transactions flag. Reads the same hub the API
 * serves; all writes go through the API routes.
 */
import Link from "next/link";
import { asc } from "drizzle-orm";
import { redirect } from "next/navigation";

import { nationalTeam } from "@/data/db/schema";
import { getFlags } from "@/data/league/feature-flags";
import { TransactionError } from "@/data/transactions/errors";
import { getTransactionHub } from "@/data/transactions/service";
import { getCurrentUser } from "@/web/auth/current-user";
import { getDb } from "@/web/db";
import { getMembershipRole } from "@/web/queries";

import LeagueTabs from "../league-tabs";
import TransactionsPanel from "./transactions-panel";

export const dynamic = "force-dynamic";

export default async function TransactionsPage({
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
  if (!flags.transactions) {
    return (
      <main className="container">
        <LeagueTabs leagueId={id} isOwner={isOwner} current="transactions" />
        <h1>Transactions</h1>
        <p className="notice">
          Transactions are not enabled for this league.
          {isOwner ? " Turn them on in Settings to get started." : ""}
        </p>
      </main>
    );
  }

  let hub;
  try {
    hub = await getTransactionHub(db, id, user.manager.id);
  } catch (e) {
    if (e instanceof TransactionError && e.code === "LEAGUE_NOT_ACTIVE") {
      return (
        <main className="container">
          <LeagueTabs leagueId={id} isOwner={isOwner} current="transactions" />
          <h1>Transactions</h1>
          <p className="notice">
            Transactions open once the draft is complete and the league is
            active.
          </p>
        </main>
      );
    }
    throw e;
  }

  const nations = await db
    .select({ id: nationalTeam.id, name: nationalTeam.name })
    .from(nationalTeam)
    .orderBy(asc(nationalTeam.name));
  const nationNameById: Record<number, string> = {};
  for (const n of nations) nationNameById[n.id] = n.name;

  return (
    <main className="container">
      <Link href={`/leagues/${id}`} className="back-link">
        &larr; League
      </Link>
      <LeagueTabs leagueId={id} isOwner={isOwner} current="transactions" />
      <h1>Transactions</h1>
      <p className="subtitle">
        Add free agents, claim players off waivers ({hub.waiverHours}h
        window, worst-placed claim wins), and trade with rival managers.
        Moves take effect from the next period that hasn&apos;t kicked off.
      </p>
      <TransactionsPanel
        leagueId={id}
        isOwner={isOwner}
        hub={JSON.parse(JSON.stringify(hub))}
        nationNameById={nationNameById}
      />
    </main>
  );
}

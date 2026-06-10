/**
 * Admin: stat editor fixture index.
 *
 * Lists every fixture with a link to its per-player stat editor. Gated by the
 * ADMIN_EMAILS allowlist (see src/web/auth/admin.ts). Force-dynamic so the
 * list reflects the latest ingested fixtures.
 */
import Link from "next/link";
import { redirect } from "next/navigation";

import { fixture, nationalTeam } from "@/data/db/schema";
import { getAdminUser } from "@/web/auth/admin";
import { getDb } from "@/web/db";

export const dynamic = "force-dynamic";

const STAGE_LABEL: Record<string, string> = {
  GROUP_1: "Group MD1",
  GROUP_2: "Group MD2",
  GROUP_3: "Group MD3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-finals",
  SF: "Semi-finals",
  THIRD_PLACE: "Third place",
  FINAL: "Final",
};

export default async function AdminStatsIndex() {
  const user = await getAdminUser();
  if (!user) redirect("/login");

  const db = getDb();
  const fixtures = await db.select().from(fixture);
  const teams = await db.select().from(nationalTeam);
  const nameById = new Map(teams.map((t) => [t.id, t.name]));

  const sorted = [...fixtures].sort(
    (a, b) => a.kickoffUtc.getTime() - b.kickoffUtc.getTime(),
  );

  return (
    <>
      <Link href="/" className="back-link">
        &larr; Home
      </Link>
      <h1>Stat editor</h1>
      <p className="subtitle">
        Hand-enter or correct any per-player stat. Edited rows are locked so a
        later provider sync will not overwrite them, and scores recompute
        automatically on save.
      </p>

      {sorted.length === 0 ? (
        <p className="notice">No fixtures ingested yet.</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Match</th>
                <th>Stage</th>
                <th>Status</th>
                <th className="num">Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => (
                <tr key={f.id}>
                  <td>
                    {nameById.get(f.homeTeamId) ?? `#${f.homeTeamId}`} v{" "}
                    {nameById.get(f.awayTeamId) ?? `#${f.awayTeamId}`}
                  </td>
                  <td>{STAGE_LABEL[f.stage] ?? f.stage}</td>
                  <td>{f.status}</td>
                  <td className="num">
                    {f.homeScore ?? "-"}&ndash;{f.awayScore ?? "-"}
                  </td>
                  <td>
                    <Link href={`/admin/stats/${f.id}`} className="btn btn-sm">
                      Edit stats
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

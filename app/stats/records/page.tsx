/**
 * Public "Records & fun stats" page: highest-scoring Team of the Stage so far,
 * the biggest single-match haul, top nations by goals, and a position-scarcity
 * heatmap (average points by position by stage). No login required.
 */
import Link from "next/link";

import { getRecords } from "@/data/stats/hub";
import type { TournamentRecords } from "@/data/stats/hub";
import type { Position } from "@/data/db/schema";
import { getDb } from "@/web/db";
import { HUB_RULESET_VERSION } from "@/web/stats-params";

import { STAGE_FULL, STAGE_LABEL, STAGE_ORDER } from "../stage-labels";
import { StagePitch } from "../stage-pitch";

export const dynamic = "force-dynamic";

const POSITION_ORDER: Position[] = ["GK", "DEF", "MID", "FWD"];

export default async function RecordsPage() {
  let data: TournamentRecords | null = null;
  let error: string | null = null;
  try {
    const db = getDb();
    data = await getRecords(db, { rulesetVersion: HUB_RULESET_VERSION });
  } catch (e) {
    error = e instanceof Error ? e.message : "could not load records";
  }

  // Build a (stage,position) -> avg lookup for the heatmap.
  const cellByKey = new Map<string, number>();
  const stagesPresent = new Set<string>();
  if (data) {
    for (const c of data.positionScarcity) {
      cellByKey.set(`${c.stage}|${c.position}`, c.avgPoints);
      stagesPresent.add(c.stage);
    }
  }
  const heatStages = STAGE_ORDER.filter((s) => stagesPresent.has(s));

  return (
    <>
      <Link href="/stats" className="back-link">
        &larr; Stats Hub
      </Link>
      <h1>Records &amp; Fun Stats</h1>

      {error ? (
        <p className="error">Could not load: {error}</p>
      ) : !data ? (
        <p className="notice">No data.</p>
      ) : (
        <>
          <h2>Highest-scoring XI of the tournament</h2>
          {data.highestScoringXi && data.highestScoringXi.xi.length > 0 ? (
            <div className="tos-layout">
              <StagePitch
                xi={data.highestScoringXi.xi}
                formation={data.highestScoringXi.formation}
              />
              <div className="tos-detail">
                <p className="tos-total">
                  {STAGE_FULL[data.highestScoringXi.stage]} &middot;{" "}
                  <strong>{data.highestScoringXi.points}</strong> pts
                </p>
              </div>
            </div>
          ) : (
            <p className="notice">No scored stage yet.</p>
          )}

          <h2>Biggest single-match haul</h2>
          {data.biggestHaul ? (
            <p className="record-line">
              <strong>{data.biggestHaul.fullName}</strong> (
              {data.biggestHaul.nationalTeamName}) &mdash;{" "}
              <strong>{data.biggestHaul.points}</strong> pts vs{" "}
              {data.biggestHaul.opponentTeamName || "—"} in{" "}
              {STAGE_LABEL[data.biggestHaul.stage]}
            </p>
          ) : (
            <p className="notice">No matches scored yet.</p>
          )}

          <h2>Most goals by nation</h2>
          {data.topNationsByGoals.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>Nation</th>
                    <th className="num">Goals</th>
                  </tr>
                </thead>
                <tbody>
                  {data.topNationsByGoals.map((n, i) => (
                    <tr key={n.nationalTeamId}>
                      <td className="num">{i + 1}</td>
                      <td>{n.nationalTeamName}</td>
                      <td className="num">{n.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">No goals recorded yet.</p>
          )}

          <h2>Position scarcity</h2>
          <p className="subtitle">
            Average fantasy points by position by stage &mdash; where the points
            are concentrated.
          </p>
          {heatStages.length > 0 ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Stage</th>
                    {POSITION_ORDER.map((p) => (
                      <th key={p} className="num">
                        {p}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {heatStages.map((s) => (
                    <tr key={s}>
                      <td>{STAGE_LABEL[s]}</td>
                      {POSITION_ORDER.map((p) => {
                        const v = cellByKey.get(`${s}|${p}`);
                        return (
                          <td key={p} className="num">
                            {v === undefined ? "—" : v}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">No scored stages yet.</p>
          )}
        </>
      )}
    </>
  );
}

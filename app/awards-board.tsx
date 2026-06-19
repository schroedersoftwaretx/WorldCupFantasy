/**
 * AwardsBoard - presentational render of a list of computed awards.
 *
 * Shared by the per-league Trophy Room and the public Stats Hub awards
 * section. Pure: it just renders the AwardResult[] its server-component parent
 * computed. League awards rank fantasy teams; global awards rank players, so
 * the leader column is labelled accordingly.
 */
import type { AwardResult } from "@/data/awards/registry";

function formatValue(value: number, unit: string): string {
  // Counting-stat units render as plain integers; point-like units keep 2dp.
  if (unit === "goals" || unit === "assists" || unit === "saves") {
    return `${value}`;
  }
  return Number.isInteger(value) ? `${value}` : value.toFixed(2);
}

export function AwardsBoard({ awards }: { awards: AwardResult[] }) {
  const anyEntries = awards.some((a) => a.entries.length > 0);
  if (!anyEntries) {
    return (
      <p className="notice">
        No awards yet &mdash; they fill in once matches start being scored.
      </p>
    );
  }

  return (
    <div className="awards-board">
      {awards.map((award) => (
        <section key={`${award.scope}-${award.id}`} className="award-card">
          <h2>{award.label}</h2>
          <p className="subtitle">{award.description}</p>
          {award.entries.length === 0 ? (
            <p className="notice">Not awarded yet.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th className="num">#</th>
                    <th>{award.scope === "league" ? "Team" : "Player"}</th>
                    <th>Detail</th>
                    <th className="num">{award.unit}</th>
                  </tr>
                </thead>
                <tbody>
                  {award.entries.map((e, i) => (
                    <tr
                      key={`${e.fantasyTeamId ?? e.playerId ?? i}-${i}`}
                      className={e.rank === 1 ? "award-leader-top" : ""}
                    >
                      <td className="num">{e.rank}</td>
                      <td>{e.title}</td>
                      <td className="award-sub">{e.subtitle}</td>
                      <td className="num">{formatValue(e.value, award.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

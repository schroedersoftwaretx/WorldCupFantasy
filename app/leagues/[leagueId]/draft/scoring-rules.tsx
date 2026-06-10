/**
 * ScoringRules — collapsible panel with the scoring table and best-ball
 * lineup explanation. Uses native <details>/<summary> — no JS state needed.
 */
export function ScoringRules() {
  return (
    <details className="panel scoring-rules-panel">
      <summary className="scoring-rules-summary">
        <h2 style={{ display: "inline", marginLeft: "0.5rem" }}>Scoring rules</h2>
      </summary>
      <div className="scoring-rules-body">
        <p className="scoring-bestball-note">
          <strong>Best ball:</strong> each scoring period your optimal lineup
          is chosen automatically — you never need to set a lineup. The XI is
          always <strong>1 GK · 4 DEF · 1 DEF/MID flex · 2 MID · 1 MID/FWD flex · 2 FWD</strong>.
          The flex slot goes to whichever eligible player scored more that period.
        </p>

        <table className="scoring-table">
          <thead>
            <tr>
              <th>Event</th>
              <th className="num">Pts</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Appearance (played any minutes)</td><td className="num pts-pos">+1</td></tr>
            <tr><td>Played 60+ minutes (additional)</td><td className="num pts-pos">+1</td></tr>
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Goals</td></tr>
            <tr><td>Goal — GK</td><td className="num pts-pos">+10</td></tr>
            <tr><td>Goal — DEF</td><td className="num pts-pos">+6</td></tr>
            <tr><td>Goal — MID</td><td className="num pts-pos">+5</td></tr>
            <tr><td>Goal — FWD</td><td className="num pts-pos">+4</td></tr>
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Other positive</td></tr>
            <tr><td>Assist (any position)</td><td className="num pts-pos">+4</td></tr>
            <tr><td>Clean sheet — GK or DEF (60+ min, 0 conceded)</td><td className="num pts-pos">+5</td></tr>
            <tr><td>Save (each, GK)</td><td className="num pts-pos">+1</td></tr>
            <tr><td>Penalty saved (GK)</td><td className="num pts-pos">+2</td></tr>
            <tr><td>Game won (GK only)</td><td className="num pts-pos">+5</td></tr>
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Detailed actions (each)</td></tr>
            <tr><td>Shot on target</td><td className="num pts-pos">+1</td></tr>
            <tr><td>Shot off target</td><td className="num pts-pos">+0.5</td></tr>
            <tr><td>Successful tackle</td><td className="num pts-pos">+0.5</td></tr>
            <tr><td>Cross</td><td className="num pts-pos">+0.5</td></tr>
            <tr><td>Completed pass</td><td className="num pts-pos">+0.05</td></tr>
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Deductions</td></tr>
            <tr><td>Yellow card</td><td className="num pts-neg">−1</td></tr>
            <tr><td>Red card</td><td className="num pts-neg">−5</td></tr>
            <tr><td>Penalty missed</td><td className="num pts-neg">−2</td></tr>
            <tr><td>Own goal</td><td className="num pts-neg">−2</td></tr>
            <tr><td>Goal conceded (GK only, each)</td><td className="num pts-neg">−1</td></tr>
          </tbody>
        </table>
        <p className="scoring-note">
          Extra-time stats count normally. Shootout goals do not score.
          Clean sheet requires 60+ minutes and 0 goals conceded in
          regulation + extra time.
        </p>
      </div>
    </details>
  );
}

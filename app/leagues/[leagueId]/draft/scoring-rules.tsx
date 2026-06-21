/**
 * ScoringRules — collapsible panel with the scoring table and best-ball
 * lineup explanation. The point values are read from the league's live
 * ScoringRuleset, so the sheet always matches the rules actually in force
 * (including any owner customizations). Uses native <details>/<summary> —
 * no JS state needed.
 */
import type { ScoringRuleset } from "@/data/scoring/ruleset";

/** Signed display, e.g. +1, +0.5, −2 (uses the unicode minus to match the app). */
function fmt(n: number): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n)}`;
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <tr>
      <td>{label}</td>
      <td className={`num ${value >= 0 ? "pts-pos" : "pts-neg"}`}>{fmt(value)}</td>
    </tr>
  );
}

export function ScoringRules({ ruleset }: { ruleset: ScoringRuleset }) {
  const csGK = ruleset.cleanSheetByPosition.GK;
  const csDEF = ruleset.cleanSheetByPosition.DEF;
  const csMin = ruleset.cleanSheetMinMinutes;
  const csCombined = csGK !== undefined && csDEF !== undefined && csGK === csDEF;

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

        <div className="table-scroll">
        <table className="scoring-table">
          <thead>
            <tr>
              <th>Event</th>
              <th className="num">Pts</th>
            </tr>
          </thead>
          <tbody>
            <Row label="Appearance (played any minutes)" value={ruleset.appearance} />
            <Row label="Played 60+ minutes (additional)" value={ruleset.played60Plus} />
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Goals</td></tr>
            <Row label="Goal — GK" value={ruleset.goalByPosition.GK} />
            <Row label="Goal — DEF" value={ruleset.goalByPosition.DEF} />
            <Row label="Goal — MID" value={ruleset.goalByPosition.MID} />
            <Row label="Goal — FWD" value={ruleset.goalByPosition.FWD} />
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Other positive</td></tr>
            <Row label="Assist (any position)" value={ruleset.assist} />
            {csCombined ? (
              <Row
                label={`Clean sheet — GK or DEF (${csMin}+ min, 0 conceded)`}
                value={csGK as number}
              />
            ) : (
              <>
                {csGK !== undefined && (
                  <Row label={`Clean sheet — GK (${csMin}+ min, 0 conceded)`} value={csGK} />
                )}
                {csDEF !== undefined && (
                  <Row label={`Clean sheet — DEF (${csMin}+ min, 0 conceded)`} value={csDEF} />
                )}
              </>
            )}
            <Row label="Save (each, GK)" value={ruleset.save} />
            <Row label="Penalty saved (GK)" value={ruleset.penaltySaved} />
            <Row label="Game won (GK only)" value={ruleset.gameWonKeeper} />
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Detailed actions (each)</td></tr>
            <Row label="Shot on target" value={ruleset.shotOnTarget} />
            <Row label="Shot off target" value={ruleset.shotOffTarget} />
            <Row label="Big chance created" value={ruleset.bigChanceCreated} />
            <Row label="Key pass" value={ruleset.keyPass} />
            <Row label="Successful tackle" value={ruleset.tackleSuccessful} />
            <Row label="Cross" value={ruleset.cross} />
            <Row label="Completed pass" value={ruleset.passCompleted} />
            <tr className="rule-divider"><td colSpan={2} className="rule-group">Deductions</td></tr>
            <Row label="Yellow card" value={ruleset.yellowCard} />
            <Row label="Red card" value={ruleset.redCard} />
            <Row label="Penalty missed" value={ruleset.penaltyMissed} />
            <Row label="Own goal" value={ruleset.ownGoal} />
            <Row label="Goal conceded (GK only, each)" value={ruleset.goalConcededByKeeper} />
          </tbody>
        </table>
        </div>
        <p className="scoring-note">
          Extra-time stats count normally. Shootout goals do not score.
          Clean sheet requires {csMin}+ minutes and 0 goals conceded in
          regulation + extra time.
        </p>
        <p className="scoring-note">
          Playmaking is never double-counted. A chance is paid once, in order
          of value: a big chance that was converted scores only the{" "}
          <strong>assist</strong>; an unconverted big chance scores only the{" "}
          <strong>big chance</strong> bonus (not the key pass on top); a plain
          key pass scores the <strong>key pass</strong> value.
        </p>
      </div>
    </details>
  );
}

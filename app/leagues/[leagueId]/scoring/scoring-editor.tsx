"use client";
/**
 * Client-side league scoring editor. Prefilled from the league's current
 * ruleset; on save it PUTs the structured rule values to
 * /api/leagues/[leagueId]/scoring, which re-versions and recomputes scores.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ScoringRuleset } from "@/data/scoring/ruleset";

interface Props {
  leagueId: number;
  ruleset: ScoringRuleset;
}

/** Flat editable state — nested maps are flattened to discrete keys. */
interface FormState {
  appearance: number;
  played60Plus: number;
  goalGK: number;
  goalDEF: number;
  goalMID: number;
  goalFWD: number;
  assist: number;
  save: number;
  csGK: number;
  csDEF: number;
  cleanSheetMinMinutes: number;
  penaltySaved: number;
  gameWonKeeper: number;
  shotOnTarget: number;
  shotOffTarget: number;
  bigChanceCreated: number;
  keyPass: number;
  cross: number;
  passCompleted: number;
  tackleSuccessful: number;
  yellowCard: number;
  redCard: number;
  penaltyMissed: number;
  ownGoal: number;
  goalConcededByKeeper: number;
}

type FieldKey = keyof FormState;

interface Field {
  key: FieldKey;
  label: string;
  /** Whole-number field (currently only the clean-sheet minutes threshold). */
  int?: boolean;
}

interface Group {
  title: string;
  fields: Field[];
}

const GROUPS: Group[] = [
  {
    title: "Appearance",
    fields: [
      { key: "appearance", label: "Appearance (any minutes)" },
      { key: "played60Plus", label: "Played 60+ minutes" },
    ],
  },
  {
    title: "Goals (by scorer position)",
    fields: [
      { key: "goalGK", label: "Goal — GK" },
      { key: "goalDEF", label: "Goal — DEF" },
      { key: "goalMID", label: "Goal — MID" },
      { key: "goalFWD", label: "Goal — FWD" },
    ],
  },
  {
    title: "Creation & goalkeeping",
    fields: [
      { key: "assist", label: "Assist" },
      { key: "save", label: "Save (each)" },
      { key: "csGK", label: "Clean sheet — GK" },
      { key: "csDEF", label: "Clean sheet — DEF" },
      { key: "cleanSheetMinMinutes", label: "Clean-sheet minimum minutes", int: true },
      { key: "penaltySaved", label: "Penalty saved" },
      { key: "gameWonKeeper", label: "Game won (GK)" },
    ],
  },
  {
    title: "Detailed actions (each)",
    fields: [
      { key: "shotOnTarget", label: "Shot on target" },
      { key: "shotOffTarget", label: "Shot off target" },
      { key: "bigChanceCreated", label: "Big chance created" },
      { key: "keyPass", label: "Key pass" },
      { key: "cross", label: "Cross" },
      { key: "passCompleted", label: "Completed pass" },
      { key: "tackleSuccessful", label: "Successful tackle" },
    ],
  },
  {
    title: "Deductions",
    fields: [
      { key: "yellowCard", label: "Yellow card" },
      { key: "redCard", label: "Red card" },
      { key: "penaltyMissed", label: "Penalty missed" },
      { key: "ownGoal", label: "Own goal" },
      { key: "goalConcededByKeeper", label: "Goal conceded (GK, each)" },
    ],
  },
];

function toForm(r: ScoringRuleset): FormState {
  return {
    appearance: r.appearance,
    played60Plus: r.played60Plus,
    goalGK: r.goalByPosition.GK,
    goalDEF: r.goalByPosition.DEF,
    goalMID: r.goalByPosition.MID,
    goalFWD: r.goalByPosition.FWD,
    assist: r.assist,
    save: r.save,
    csGK: r.cleanSheetByPosition.GK ?? 0,
    csDEF: r.cleanSheetByPosition.DEF ?? 0,
    cleanSheetMinMinutes: r.cleanSheetMinMinutes,
    penaltySaved: r.penaltySaved,
    gameWonKeeper: r.gameWonKeeper,
    shotOnTarget: r.shotOnTarget,
    shotOffTarget: r.shotOffTarget,
    bigChanceCreated: r.bigChanceCreated,
    keyPass: r.keyPass,
    cross: r.cross,
    passCompleted: r.passCompleted,
    tackleSuccessful: r.tackleSuccessful,
    yellowCard: r.yellowCard,
    redCard: r.redCard,
    penaltyMissed: r.penaltyMissed,
    ownGoal: r.ownGoal,
    goalConcededByKeeper: r.goalConcededByKeeper,
  };
}

/** Assemble the structured request body the API's sanitizer expects. */
function toBody(s: FormState) {
  return {
    appearance: s.appearance,
    played60Plus: s.played60Plus,
    goalByPosition: { GK: s.goalGK, DEF: s.goalDEF, MID: s.goalMID, FWD: s.goalFWD },
    assist: s.assist,
    save: s.save,
    cleanSheetByPosition: { GK: s.csGK, DEF: s.csDEF },
    cleanSheetMinMinutes: s.cleanSheetMinMinutes,
    penaltySaved: s.penaltySaved,
    penaltyMissed: s.penaltyMissed,
    ownGoal: s.ownGoal,
    yellowCard: s.yellowCard,
    redCard: s.redCard,
    shotOnTarget: s.shotOnTarget,
    shotOffTarget: s.shotOffTarget,
    tackleSuccessful: s.tackleSuccessful,
    cross: s.cross,
    passCompleted: s.passCompleted,
    keyPass: s.keyPass,
    bigChanceCreated: s.bigChanceCreated,
    goalConcededByKeeper: s.goalConcededByKeeper,
    gameWonKeeper: s.gameWonKeeper,
  };
}

export default function ScoringEditor({ leagueId, ruleset }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => toForm(ruleset));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  function setField(key: FieldKey, raw: string) {
    const n = Number(raw);
    setForm((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : prev[key] }));
  }

  function reset() {
    setForm(toForm(ruleset));
    setMsg(null);
    setIsError(false);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    setIsError(false);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/scoring`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toBody(form)),
      });
      const json = await res.json();
      if (json.ok) {
        const d = json.data as {
          version: string;
          inserted: number;
          updated: number;
          skipped: number;
        };
        setMsg(
          `Saved — ruleset ${d.version}. Rescored: ${d.inserted} new, ${d.updated} updated, ${d.skipped} unchanged.`,
        );
        router.refresh();
      } else {
        setIsError(true);
        setMsg(json.error?.message ?? "Save failed.");
      }
    } catch (e) {
      setIsError(true);
      setMsg(e instanceof Error ? e.message : "Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="scoring-editor">
      {GROUPS.map((g) => (
        <fieldset key={g.title} className="panel scoring-editor-group">
          <legend>{g.title}</legend>
          <div className="scoring-editor-fields">
            {g.fields.map((f) => (
              <label key={f.key} className="scoring-editor-field">
                <span>{f.label}</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={f.int ? 1 : 0.05}
                  value={form[f.key]}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <div className="scoring-editor-actions">
        <button className="btn" onClick={save} disabled={busy}>
          {busy ? "Saving & rescoring…" : "Save & recompute"}
        </button>
        <button className="btn btn-sm" onClick={reset} disabled={busy} type="button">
          Reset
        </button>
        {msg && (
          <span className={isError ? "recompute-error" : "recompute-ok"}>{msg}</span>
        )}
      </div>
    </div>
  );
}

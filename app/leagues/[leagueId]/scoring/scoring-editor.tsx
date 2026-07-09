"use client";
/**
 * Client-side league scoring editor. Prefilled from the league's current
 * ruleset; on save it PUTs the structured rule values to
 * /api/leagues/[leagueId]/scoring, which re-versions and recomputes scores.
 */
import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ScoringRuleset } from "@/data/scoring/ruleset";

/** Stages that can carry a whole-score multiplier, in tournament order. */
const STAGES = [
  "GROUP_1",
  "GROUP_2",
  "GROUP_3",
  "R32",
  "R16",
  "QF",
  "SF",
  "THIRD_PLACE",
  "FINAL",
] as const;
type StageKey = (typeof STAGES)[number];

const STAGE_LABELS: Record<StageKey, string> = {
  GROUP_1: "Group MD1",
  GROUP_2: "Group MD2",
  GROUP_3: "Group MD3",
  R32: "Round of 32",
  R16: "Round of 16",
  QF: "Quarter-final",
  SF: "Semi-final",
  THIRD_PLACE: "Third place",
  FINAL: "Final",
};

/** Editable state for the opt-in phase-07 bonuses block. */
interface BonusesState {
  enabled: boolean;
  brace: number;
  hatTrick: number;
  streakLength: number;
  streakBonus: number;
  /** Multiplier per stage; 1 = no boost (omitted from the saved ruleset). */
  stageMultipliers: Record<StageKey, number>;
}

function defaultBonuses(): BonusesState {
  return {
    enabled: false,
    brace: 2,
    hatTrick: 5,
    streakLength: 3,
    streakBonus: 2,
    stageMultipliers: {
      GROUP_1: 1,
      GROUP_2: 1,
      GROUP_3: 1,
      R32: 1,
      R16: 1,
      QF: 1,
      SF: 1,
      THIRD_PLACE: 1,
      FINAL: 1,
    },
  };
}

function bonusesFromRuleset(r: ScoringRuleset): BonusesState {
  const base = defaultBonuses();
  if (!r.bonuses) return base;
  const mults = { ...base.stageMultipliers };
  for (const stage of STAGES) {
    const v = r.bonuses.stageMultipliers[stage];
    if (typeof v === "number") mults[stage] = v;
  }
  return {
    enabled: true,
    brace: r.bonuses.brace,
    hatTrick: r.bonuses.hatTrick,
    streakLength: r.bonuses.scoringStreak.length,
    streakBonus: r.bonuses.scoringStreak.bonus,
    stageMultipliers: mults,
  };
}

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
function toBody(s: FormState, b: BonusesState) {
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
    // The bonuses block is only sent when enabled; multipliers equal to 1
    // are omitted so the stored ruleset (and its version hash) stays
    // minimal. Disabled = key absent = default-identical hash.
    ...(b.enabled
      ? {
          bonuses: {
            brace: b.brace,
            hatTrick: b.hatTrick,
            stageMultipliers: Object.fromEntries(
              STAGES.filter((st) => b.stageMultipliers[st] !== 1).map((st) => [
                st,
                b.stageMultipliers[st],
              ]),
            ),
            scoringStreak: { length: b.streakLength, bonus: b.streakBonus },
          },
        }
      : {}),
  };
}

export default function ScoringEditor({ leagueId, ruleset }: Props) {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(() => toForm(ruleset));
  const [bonuses, setBonuses] = useState<BonusesState>(() =>
    bonusesFromRuleset(ruleset),
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);

  function setField(key: FieldKey, raw: string) {
    const n = Number(raw);
    setForm((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : prev[key] }));
  }

  function reset() {
    setForm(toForm(ruleset));
    setBonuses(bonusesFromRuleset(ruleset));
    setMsg(null);
    setIsError(false);
  }

  function setBonusNumber(
    key: "brace" | "hatTrick" | "streakLength" | "streakBonus",
    raw: string,
  ) {
    const n = Number(raw);
    setBonuses((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : prev[key] }));
  }

  function setStageMultiplier(stage: StageKey, raw: string) {
    const n = Number(raw);
    setBonuses((prev) => ({
      ...prev,
      stageMultipliers: {
        ...prev.stageMultipliers,
        [stage]: Number.isFinite(n) ? n : prev.stageMultipliers[stage],
      },
    }));
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    setIsError(false);
    try {
      const res = await fetch(`/api/leagues/${leagueId}/scoring`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(toBody(form, bonuses)),
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

      <fieldset className="panel scoring-editor-group">
        <legend>Bonuses (optional)</legend>
        <label className="scoring-editor-field">
          <span>Enable bonus scoring</span>
          <input
            type="checkbox"
            checked={bonuses.enabled}
            onChange={(e) =>
              setBonuses((prev) => ({ ...prev, enabled: e.target.checked }))
            }
          />
        </label>
        {bonuses.enabled ? (
          <>
            <div className="scoring-editor-fields">
              <label className="scoring-editor-field">
                <span>Brace (exactly 2 goals)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={0.5}
                  value={bonuses.brace}
                  onChange={(e) => setBonusNumber("brace", e.target.value)}
                />
              </label>
              <label className="scoring-editor-field">
                <span>Hat-trick (3+ goals, replaces brace)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={0.5}
                  value={bonuses.hatTrick}
                  onChange={(e) => setBonusNumber("hatTrick", e.target.value)}
                />
              </label>
              <label className="scoring-editor-field">
                <span>Scoring-streak length (2–10 played matches)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  step={1}
                  min={2}
                  max={10}
                  value={bonuses.streakLength}
                  onChange={(e) => setBonusNumber("streakLength", e.target.value)}
                />
              </label>
              <label className="scoring-editor-field">
                <span>Scoring-streak bonus (per match extending it)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step={0.5}
                  value={bonuses.streakBonus}
                  onChange={(e) => setBonusNumber("streakBonus", e.target.value)}
                />
              </label>
            </div>
            <p className="subtitle">
              Stage multipliers scale a player&apos;s whole match score
              (after flat bonuses). 1 = no boost.
            </p>
            <div className="scoring-editor-fields">
              {STAGES.map((stage) => (
                <label key={stage} className="scoring-editor-field">
                  <span>{STAGE_LABELS[stage]}</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step={0.25}
                    min={0}
                    max={10}
                    value={bonuses.stageMultipliers[stage]}
                    onChange={(e) => setStageMultiplier(stage, e.target.value)}
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <p className="subtitle">
            Off = scoring is unchanged (same ruleset version). Turning bonuses
            on re-versions the ruleset and recomputes all scores for this
            league.
          </p>
        )}
      </fieldset>

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

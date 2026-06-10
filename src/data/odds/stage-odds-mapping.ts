/**
 * Pure mapping helpers from The Odds API "outrights" responses to per-team
 * reach-stage probabilities.
 *
 * The Odds API exposes tournament futures as dedicated sport keys (e.g.
 * `soccer_fifa_world_cup_winner`, and bookmaker "to reach the final" /
 * "to reach the semi-final" markets where offered). Each event carries an
 * `outrights` market whose outcomes are { name: <team>, price: <decimal> }.
 *
 * Converting odds -> probability:
 *   implied = 1 / decimal_odds (averaged across bookmakers that carry it)
 * then we DE-VIG by scaling so the field sums to the number of SLOTS at that
 * stage. A winner market has 1 slot (sum -> 1); "reach the final" has 2 (two
 * finalists, sum -> 2); reach SF -> 4; reach QF -> 8; reach last-16 -> 16.
 * This removes the bookmaker overround correctly for multi-winner markets.
 */

export interface RawOutrightOutcome {
  name: string; // team name
  price: number; // decimal odds
}

export interface RawOutrightMarket {
  key: string; // "outrights"
  outcomes: RawOutrightOutcome[];
}

export interface RawOutrightBookmaker {
  key: string;
  title: string;
  markets: RawOutrightMarket[];
}

export interface RawOutrightEvent {
  id: string;
  sport_key: string;
  bookmakers: RawOutrightBookmaker[];
}

function decimalToImplied(decimal: number): number {
  return decimal > 0 ? 1 / decimal : 0;
}

/**
 * Average the implied probability for each team across every bookmaker that
 * carries an outrights market in these events. Returns team name -> raw
 * (pre-de-vig) implied probability.
 */
function averageOutrights(events: RawOutrightEvent[]): Map<string, number> {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const event of events) {
    for (const bm of event.bookmakers ?? []) {
      const market = bm.markets?.find((m) => m.key === "outrights");
      if (!market) continue;
      for (const o of market.outcomes ?? []) {
        const implied = decimalToImplied(o.price);
        if (implied <= 0) continue;
        sums.set(o.name, (sums.get(o.name) ?? 0) + implied);
        counts.set(o.name, (counts.get(o.name) ?? 0) + 1);
      }
    }
  }

  const avg = new Map<string, number>();
  for (const [name, sum] of sums) {
    avg.set(name, sum / (counts.get(name) ?? 1));
  }
  return avg;
}

/**
 * Map raw outright events for ONE stage to de-vigged reach probabilities.
 *
 * @param events raw events from The Odds API for the stage's sport key
 * @param slots  number of teams that occupy this stage (1 champion, 2 finalists, ...)
 * @returns team name -> probability in [0, 1] of reaching the stage. Empty when
 *          no bookmaker offered the market.
 */
export function mapStageOutrights(
  events: RawOutrightEvent[],
  slots: number,
): Map<string, number> {
  const raw = averageOutrights(events);
  const result = new Map<string, number>();
  if (raw.size === 0) return result;

  const total = [...raw.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return result;

  const scale = slots / total;
  for (const [name, p] of raw) {
    // De-vig to the slot count, then clamp: no team reaches a stage with prob > 1.
    result.set(name, Math.min(1, p * scale));
  }
  return result;
}

// --- team-name normalization & matching ------------------------------------

export function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\b(ir|republic of|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Best fuzzy match of an Odds API team name to one of our national teams.
 * Returns the matched team id, or null when nothing scores above threshold.
 */
export function matchTeamName(
  apiName: string,
  teams: ReadonlyArray<{ id: number; name: string }>,
): number | null {
  const target = normalizeTeamName(apiName);
  if (!target) return null;

  let bestId: number | null = null;
  let bestScore = 0;
  for (const t of teams) {
    const cand = normalizeTeamName(t.name);
    let score = 0;
    if (cand === target) score = 1;
    else if (cand.includes(target) || target.includes(cand)) score = 0.6;
    else {
      const candWords = new Set(cand.split(" ").filter((w) => w.length > 2));
      const overlap = target
        .split(" ")
        .filter((w) => w.length > 2 && candWords.has(w)).length;
      score = overlap > 0 ? 0.3 * overlap : 0;
    }
    if (score > bestScore) {
      bestScore = score;
      bestId = t.id;
    }
  }
  return bestScore >= 0.6 ? bestId : null;
}

/**
 * Pure mapping helpers from The Odds API v4 responses to our internal
 * MatchOdds type.
 *
 * The Odds API returns bookmaker odds in decimal format. We convert to
 * implied probabilities (1 / decimal_odds) and normalize to sum to 1.0
 * to remove the bookmaker's overround (vig).
 *
 * Markets we consume:
 *   h2h    - 1X2 result odds → homeWinP, drawP, awayWinP
 *   totals - over/under goals → expectedTotalGoals
 *   btts   - both teams to score (optional, improves clean sheet estimate)
 *
 * Clean sheet probability derivation (no direct market available for free):
 *   P(home clean sheet) ≈ P(away scores 0)
 *   Using a Poisson approximation: if λ_away = expected away goals,
 *   P(0 away goals) = e^(-λ_away)
 *   We split expected total goals using result probabilities as a weight.
 */

export interface RawOddsEvent {
  id: string;
  sport_key: string;
  commence_time: string; // ISO8601
  home_team: string;
  away_team: string;
  bookmakers: RawBookmaker[];
}

export interface RawBookmaker {
  key: string;
  title: string;
  markets: RawMarket[];
}

export interface RawMarket {
  key: string; // "h2h" | "totals" | "btts"
  outcomes: RawOutcome[];
}

export interface RawOutcome {
  name: string;
  price: number; // decimal odds
  point?: number; // for totals: the line (e.g. 2.5)
}

/** Our cleaned, provider-agnostic match odds. */
export interface MatchOdds {
  /** ISO8601 kickoff — used to correlate with our fixture table. */
  commenceTime: string;
  homeTeamName: string;
  awayTeamName: string;
  homeWinP: number;
  drawP: number;
  awayWinP: number;
  /** Market-implied expected total goals (from over/under line). */
  expectedTotalGoals: number;
  /** P(home team concedes 0) in regulation+ET. */
  homeCleanSheetP: number;
  /** P(away team concedes 0) in regulation+ET. */
  awayCleanSheetP: number;
}

// ---------------------------------------------------------------------------

/**
 * Convert decimal odds to raw implied probability (before normalization).
 * Odds of 0 or negative are invalid; return 0.
 */
function decimalToImplied(decimal: number): number {
  return decimal > 0 ? 1 / decimal : 0;
}

/**
 * Normalize a set of implied probabilities to sum to 1.0 (remove vig).
 */
function normalize(probs: number[]): number[] {
  const total = probs.reduce((a, b) => a + b, 0);
  if (total <= 0) return probs.map(() => 1 / probs.length);
  return probs.map((p) => p / total);
}

/**
 * From a list of bookmakers, find the best available market by key and
 * average the implied probabilities across all books that carry it.
 * Returns null when no bookmaker has the requested market.
 */
function averageMarket(
  bookmakers: RawBookmaker[],
  marketKey: string,
): Map<string, number> | null {
  const sums = new Map<string, number>();
  const counts = new Map<string, number>();

  for (const bm of bookmakers) {
    const market = bm.markets.find((m) => m.key === marketKey);
    if (!market) continue;
    for (const outcome of market.outcomes) {
      sums.set(outcome.name, (sums.get(outcome.name) ?? 0) + decimalToImplied(outcome.price));
      counts.set(outcome.name, (counts.get(outcome.name) ?? 0) + 1);
    }
  }

  if (sums.size === 0) return null;

  const avg = new Map<string, number>();
  for (const [name, sum] of sums) {
    avg.set(name, sum / (counts.get(name) ?? 1));
  }
  return avg;
}

/**
 * Extract the consensus over/under line and its over-implied probability
 * from the totals market. Returns the line (e.g. 2.5) and raw over-prob.
 */
function extractTotals(bookmakers: RawBookmaker[]): { line: number; overP: number } | null {
  // Pick the most common line across bookmakers
  const lineCounts = new Map<number, number>();
  for (const bm of bookmakers) {
    const market = bm.markets.find((m) => m.key === "totals");
    if (!market) continue;
    for (const outcome of market.outcomes) {
      if (outcome.point !== undefined) {
        lineCounts.set(outcome.point, (lineCounts.get(outcome.point) ?? 0) + 1);
      }
    }
  }
  if (lineCounts.size === 0) return null;

  const consensusLine = [...lineCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];

  // Average over-implied-prob at that line
  let overSum = 0;
  let overCount = 0;
  for (const bm of bookmakers) {
    const market = bm.markets.find((m) => m.key === "totals");
    if (!market) continue;
    const over = market.outcomes.find(
      (o) => o.name === "Over" && o.point === consensusLine,
    );
    if (over) {
      overSum += decimalToImplied(over.price);
      overCount++;
    }
  }

  if (overCount === 0) return null;
  return { line: consensusLine, overP: overSum / overCount };
}

/**
 * Estimate expected total goals from the over/under market.
 *
 * The over/under line L with overP tells us P(goals > L). Using a Poisson
 * distribution this is a transcendental equation; for practical purposes we
 * approximate with a simple linear interpolation:
 *   expectedGoals ≈ L + 0.5 + (overP - 0.5) * 1.2
 * This produces reasonable estimates (e.g. L=2.5, overP=0.55 → ~2.66).
 */
function expectedGoalsFromTotals(line: number, overP: number): number {
  return Math.max(0.5, line + 0.5 + (overP - 0.5) * 1.2);
}

/**
 * Estimate per-team expected goals from total expected goals and result odds.
 * Uses result probabilities as a soft weight: a heavy favourite scores more.
 *
 * λ_home ≈ expectedTotal * (0.5 + 0.5 * (homeWinP - awayWinP))
 * λ_away = expectedTotal - λ_home
 */
function splitExpectedGoals(
  expectedTotal: number,
  homeWinP: number,
  awayWinP: number,
): { lambdaHome: number; lambdaAway: number } {
  const bias = 0.5 * (homeWinP - awayWinP);
  const lambdaHome = Math.max(0.1, expectedTotal * (0.5 + bias));
  const lambdaAway = Math.max(0.1, expectedTotal - lambdaHome);
  return { lambdaHome, lambdaAway };
}

/**
 * Poisson P(X=0) = e^(-λ). Used to estimate clean sheet probability.
 */
function poissonZero(lambda: number): number {
  return Math.exp(-lambda);
}

// ---------------------------------------------------------------------------

/**
 * Map a single raw odds event to our MatchOdds type.
 * Returns null if the event doesn't have enough data to produce a useful estimate.
 */
export function mapOddsEvent(event: RawOddsEvent): MatchOdds | null {
  const { bookmakers, home_team, away_team, commence_time } = event;
  if (!bookmakers || bookmakers.length === 0) return null;

  // --- 1X2 result probabilities ---
  const h2hAvg = averageMarket(bookmakers, "h2h");
  let homeWinP = 0.35;
  let drawP = 0.25;
  let awayWinP = 0.40;

  if (h2hAvg && h2hAvg.size >= 2) {
    const rawHome = h2hAvg.get(home_team) ?? 0;
    const rawDraw = h2hAvg.get("Draw") ?? 0;
    const rawAway = h2hAvg.get(away_team) ?? 0;
    const [nHome, nDraw, nAway] = normalize([rawHome, rawDraw, rawAway]);
    if (nHome !== undefined && nDraw !== undefined && nAway !== undefined) {
      homeWinP = nHome;
      drawP = nDraw;
      awayWinP = nAway;
    }
  }

  // --- Expected total goals ---
  const totals = extractTotals(bookmakers);
  // Default: typical WC match is slightly under 2.5
  const expectedTotalGoals = totals
    ? expectedGoalsFromTotals(totals.line, totals.overP)
    : 2.3;

  // --- Per-team λ and clean sheet probability ---
  const { lambdaHome, lambdaAway } = splitExpectedGoals(
    expectedTotalGoals,
    homeWinP,
    awayWinP,
  );
  // Home keeps clean sheet ≈ P(away scores 0)
  const homeCleanSheetP = poissonZero(lambdaAway);
  // Away keeps clean sheet ≈ P(home scores 0)
  const awayCleanSheetP = poissonZero(lambdaHome);

  return {
    commenceTime: commence_time,
    homeTeamName: home_team,
    awayTeamName: away_team,
    homeWinP,
    drawP,
    awayWinP,
    expectedTotalGoals,
    homeCleanSheetP,
    awayCleanSheetP,
  };
}

/**
 * Map a full array of raw events, skipping any that can't be mapped.
 */
export function mapOddsEvents(events: RawOddsEvent[]): MatchOdds[] {
  return events.flatMap((e) => {
    const mapped = mapOddsEvent(e);
    return mapped ? [mapped] : [];
  });
}

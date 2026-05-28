/**
 * Domain errors for the league, roster, and draft services.
 *
 * These represent rule violations the caller is expected to handle (a full
 * league, an expired invite, an illegal roster move, an out-of-turn pick)
 * - as opposed to programming errors. Throwing a typed error lets the
 * eventual API layer map them to clean 4xx responses.
 */
export class LeagueError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "LEAGUE_FULL". */
    public readonly code: string,
  ) {
    super(message);
    this.name = "LeagueError";
  }
}

export class RosterError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "RosterError";
  }
}

export class DraftError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DraftError";
  }
}

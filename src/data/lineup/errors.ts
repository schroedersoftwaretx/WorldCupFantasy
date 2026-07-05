/**
 * Domain errors for the lineup service (SET_LINEUP format). Rule violations
 * the caller is expected to handle - mapped to 4xx by the API layer, same
 * pattern as LeagueError / RosterError / DraftError.
 */
export class LineupError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "LINEUP_LOCKED". */
    public readonly code: string,
  ) {
    super(message);
    this.name = "LineupError";
  }
}

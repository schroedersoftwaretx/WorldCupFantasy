/**
 * Domain errors for the head-to-head services. Rule violations the caller
 * is expected to handle - mapped to 4xx by the API layer, same pattern as
 * LeagueError / RosterError / DraftError / LineupError.
 */
export class H2hError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "H2H_SCHEDULE_LOCKED". */
    public readonly code: string,
  ) {
    super(message);
    this.name = "H2hError";
  }
}

/**
 * Domain errors for the transactions service. Rule violations the caller is
 * expected to handle - mapped to 4xx by the API layer, same pattern as the
 * other domain errors.
 */
export class TransactionError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "PLAYER_ON_WAIVERS". */
    public readonly code: string,
  ) {
    super(message);
    this.name = "TransactionError";
  }
}

/**
 * Domain errors for the chips service. Rule violations the caller is
 * expected to handle - mapped to 4xx by the API layer, same pattern as
 * the other domain errors.
 */
export class ChipsError extends Error {
  constructor(
    message: string,
    /** Stable machine-readable code, e.g. "CHIP_ALREADY_USED". */
    public readonly code: string,
  ) {
    super(message);
    this.name = "ChipsError";
  }
}

/**
 * Request validation helpers built on zod, designed to plug into `handle()`.
 *
 * Both helpers throw an `HttpError` on bad input, so callers simply do
 *
 *   const body = await parseBody(request, MySchema);
 *
 * inside a `handle(async () => { ... })` block and let the envelope machinery
 * map the failure to `{ ok: false, error: { message, code } }` with status 400.
 * Validation failures use the shared `VALIDATION` code; a body that is not
 * even JSON uses `INVALID_BODY`. We never invent a second error format.
 */
import { z, type ZodType } from "zod";

import { HttpError } from "./api.js";

/** Flatten zod issues into a single human-readable line. */
function formatIssues(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string {
  const parts = error.issues.map((issue) => {
    const path = issue.path.join(".");
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  // De-dupe while preserving order; fall back to a generic message.
  const seen = new Set<string>();
  const unique = parts.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
  return unique.length > 0 ? unique.join("; ") : "invalid request";
}

/**
 * Parse and validate a JSON request body against `schema`.
 * - malformed JSON       -> HttpError("invalid JSON body", "INVALID_BODY", 400)
 * - schema violation     -> HttpError(<readable>, "VALIDATION", 400)
 */
export async function parseBody<S extends ZodType>(
  request: Request,
  schema: S,
): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new HttpError("invalid JSON body", "INVALID_BODY", 400);
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new HttpError(formatIssues(result.error), "VALIDATION", 400);
  }
  return result.data;
}

/**
 * Parse and validate query params against `schema`. Reads every param as a
 * string (use `z.coerce.*` in the schema for numbers/booleans). Repeated keys
 * collapse to the last value, matching `URLSearchParams.get`.
 *
 * schema violation -> HttpError(<readable>, "VALIDATION", 400)
 */
export function parseQuery<S extends ZodType>(
  searchParams: URLSearchParams,
  schema: S,
): z.infer<S> {
  const obj: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    obj[key] = value;
  }
  const result = schema.safeParse(obj);
  if (!result.success) {
    throw new HttpError(formatIssues(result.error), "VALIDATION", 400);
  }
  return result.data;
}

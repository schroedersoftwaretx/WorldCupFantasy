/**
 * HTTP plumbing for the route handlers under `app/api`.
 *
 * Every API route returns a consistent JSON envelope:
 *
 *   success -> { "ok": true,  "data": <T> }
 *   failure -> { "ok": false, "error": { "message": string, "code": string } }
 *
 * `handle()` wraps a route body so each handler only writes the happy path.
 * It maps the backend's typed domain errors (LeagueError / RosterError /
 * DraftError) to HTTP 400, an explicit `HttpError` to its chosen status,
 * and anything else to 500.
 */
import {
  DraftError,
  LeagueError,
  RosterError,
} from "../data/league/errors.js";
import { LineupError } from "@/data/lineup/errors";
import { logger } from "../log.js";

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: { message: string; code: string };
}

export type ApiResponse<T> = ApiOk<T> | ApiErr;

/**
 * An error a route handler raises to return a specific HTTP status -
 * e.g. a 404 for a missing league or a 400 for a malformed path param.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    /** Extra response headers to attach (e.g. Retry-After on a 429). */
    public readonly headers?: HeadersInit,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Build a success response, optionally with extra headers (e.g. Set-Cookie). */
export function ok<T>(data: T, status = 200, headers?: HeadersInit): Response {
  const body: ApiOk<T> = { ok: true, data };
  const init: ResponseInit = headers ? { status, headers } : { status };
  return Response.json(body, init);
}

/** Build a failure response, optionally with extra headers (e.g. Retry-After). */
export function err(
  message: string,
  code: string,
  status: number,
  headers?: HeadersInit,
): Response {
  const body: ApiErr = { ok: false, error: { message, code } };
  const init: ResponseInit = headers ? { status, headers } : { status };
  return Response.json(body, init);
}

/**
 * Run a route body, returning its value as a success envelope. Any thrown
 * error is mapped to the appropriate failure envelope and status.
 */
export async function handle<T>(fn: () => Promise<T> | T): Promise<Response> {
  try {
    return ok(await fn());
  } catch (e) {
    if (e instanceof HttpError) {
      return err(e.message, e.code, e.status, e.headers);
    }
    if (
      e instanceof LeagueError ||
      e instanceof RosterError ||
      e instanceof DraftError ||
      e instanceof LineupError
    ) {
      // Domain rule violations are the caller's fault -> 400.
      return err(e.message, e.code, 400);
    }
    logger.error("[api] unhandled error", { err: e });
    const message = e instanceof Error ? e.message : "internal server error";
    return err(message, "INTERNAL", 500);
  }
}

/**
 * Parse a path segment as a positive integer id, or throw an HttpError 400.
 */
export function parseId(raw: string, label = "id"): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new HttpError(`invalid ${label}: ${raw}`, "INVALID_ID", 400);
  }
  return id;
}

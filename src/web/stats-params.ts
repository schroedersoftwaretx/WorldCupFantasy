/**
 * Shared helpers for the public Stats Hub surfaces.
 *
 * The Hub is tournament-wide and not tied to any league, so it scores against
 * the canonical DEFAULT_RULESET (the same ruleset a freshly created league
 * gets). Routes and server components import HUB_RULESET_VERSION rather than
 * re-deriving it.
 */
import { stageEnum, type Stage } from "../data/db/schema.js";
import { DEFAULT_RULESET } from "../data/scoring/ruleset.js";
import { HttpError } from "./api.js";

/** The canonical ruleset version the public Stats Hub reports against. */
export const HUB_RULESET_VERSION = DEFAULT_RULESET.version;

/** True when `raw` is one of the nine tournament stages. */
export function isStage(raw: string): raw is Stage {
  return (stageEnum.enumValues as readonly string[]).includes(raw);
}

/** Parse a path/query segment into a Stage, or throw an HttpError 400. */
export function parseStage(raw: string): Stage {
  if (isStage(raw)) return raw;
  throw new HttpError(`invalid stage: ${raw}`, "INVALID_STAGE", 400);
}

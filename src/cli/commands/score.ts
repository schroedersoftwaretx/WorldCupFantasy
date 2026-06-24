/**
 * Scoring recompute subcommand.
 */

import { recomputeAll, recomputeForFixture } from "../../data/scoring/recompute.js";
import { DEFAULT_RULESET } from "../../data/scoring/ruleset.js";
import { formatSummary, type Subcommand } from "../helpers.js";

export const scoreCommands: Record<string, Subcommand> = {
  "score:recompute": async ({ db, args }) => {
    const ruleset = DEFAULT_RULESET;
    const target = args[0];
    if (target) {
      const summary = await recomputeForFixture(db, ruleset, target);
      console.log(
        `score fx=${target} ruleset=${ruleset.version} ${formatSummary(summary)}`,
      );
    } else {
      const summary = await recomputeAll(db, ruleset);
      console.log(`score all ruleset=${ruleset.version} ${formatSummary(summary)}`);
    }
  },
};
